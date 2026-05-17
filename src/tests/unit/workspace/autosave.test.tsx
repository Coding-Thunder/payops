import { act, render } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { useAutosave } from "@/workspace/hooks/use-autosave";

/**
 * Tiny harness — useAutosave is a hook so we wrap it in a component that
 * exposes the state via render output, lets the test drive the value, and
 * counts save invocations.
 */
function makeHarness() {
  const saves: unknown[] = [];
  let saveResolver: ((v: void) => void) | null = null;

  const save = vi.fn(async (snapshot: unknown) => {
    saves.push(snapshot);
    if (saveResolver) {
      await new Promise<void>((r) => {
        saveResolver = r;
      });
    }
  });

  function pauseSaves() {
    saveResolver = () => undefined;
  }
  function releaseSaves() {
    if (saveResolver) {
      const r = saveResolver;
      saveResolver = null;
      r();
    }
  }

  function Harness({ value, debounce = 30 }: { value: unknown; debounce?: number }) {
    const state = useAutosave({
      value,
      debounceMs: debounce,
      save,
    });
    return (
      <div>
        <span data-testid="status">{state.status}</span>
        <span data-testid="lastSavedAt">{state.lastSavedAt ?? ""}</span>
      </div>
    );
  }

  return { Harness, save, saves, pauseSaves, releaseSaves };
}

describe("useAutosave", () => {
  it("debounces a save until the value settles", async () => {
    vi.useFakeTimers();
    const { Harness, save } = makeHarness();
    const { rerender, getByTestId } = render(<Harness value={{ x: 1 }} />);

    // Initial value matches lastSaved — no scheduled save.
    expect(save).not.toHaveBeenCalled();

    // Rapid changes within the debounce window: only the last one fires.
    rerender(<Harness value={{ x: 2 }} />);
    rerender(<Harness value={{ x: 3 }} />);
    rerender(<Harness value={{ x: 4 }} />);
    expect(getByTestId("status").textContent).toBe("scheduled");

    await act(async () => {
      vi.advanceTimersByTime(40);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ x: 4 });
    vi.useRealTimers();
  });

  it("skips the save when nothing changed", async () => {
    vi.useFakeTimers();
    const { Harness, save } = makeHarness();
    const value = { same: true };
    const { rerender } = render(<Harness value={value} />);
    rerender(<Harness value={{ same: true }} />); // shallow-equal, JSON-equal
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(save).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("re-runs once the next change comes through", async () => {
    vi.useFakeTimers();
    const { Harness, save } = makeHarness();
    const { rerender } = render(<Harness value={{ n: 0 }} />);
    rerender(<Harness value={{ n: 1 }} />);
    await act(async () => {
      vi.advanceTimersByTime(40);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);

    rerender(<Harness value={{ n: 2 }} />);
    await act(async () => {
      vi.advanceTimersByTime(40);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toEqual({ n: 2 });
    vi.useRealTimers();
  });

  it("surfaces errors as status=error", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {
      throw new Error("network down");
    });
    function Harness({ v }: { v: number }) {
      const s = useAutosave({ value: v, debounceMs: 20, save });
      return <span data-testid="status">{s.status}</span>;
    }
    const { rerender, getByTestId } = render(<Harness v={0} />);
    rerender(<Harness v={1} />);
    await act(async () => {
      vi.advanceTimersByTime(30);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getByTestId("status").textContent).toBe("error");
    vi.useRealTimers();
  });
});
