import { describe, expect, it } from "vitest";

import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Textarea } from "@/components/ui/textarea";
import { renderWithUser, screen } from "@/tests/utils/render";

/**
 * Sensitive form fields are masked from session recordings.
 *
 * `data-clarity-mask="true"` is the only masking primitive that lives in our
 * code. Everything else Clarity offers is a dashboard setting: a project
 * admin can flip the masking mode to Relaxed, it takes effect in about an
 * hour, it is not retroactive, and it leaves no trace in version control.
 * So the attribute on the shared primitives is the part we can actually
 * review and test — hence this file.
 *
 * The attribute must be an unconditional literal. Clarity's implementation
 * tests for attribute PRESENCE and ignores the value, which means a React
 * boolean would render `data-clarity-mask="false"` and still mask, while the
 * mirror-image `data-clarity-unmask="false"` would UNMASK. Anything that
 * makes either one conditional is a bug, so these tests assert the literal
 * string rather than merely "the attribute exists".
 */

describe("session-recording masking", () => {
  it("masks every Input, whatever its type", () => {
    renderWithUser(
      <>
        <Input aria-label="email" type="email" />
        <Input aria-label="text" type="text" />
        <Input aria-label="secret" type="password" />
      </>,
    );
    for (const label of ["email", "text", "secret"]) {
      expect(
        screen.getByLabelText(label).getAttribute("data-clarity-mask"),
        `${label} input is not masked`,
      ).toBe("true");
    }
  });

  it("masks Textarea, which holds the least predictable content", () => {
    // Client notes, internal ops notes, dispute commentary.
    renderWithUser(<Textarea aria-label="notes" />);
    expect(screen.getByLabelText("notes")).toHaveAttribute(
      "data-clarity-mask",
      "true",
    );
  });

  it("keeps PasswordInput masked after the eye-toggle reveals it", async () => {
    // The toggle flips the field to type="text". Clarity's own excludelist
    // keys off `type="password"`, so without the attribute the revealed
    // plaintext would be capturable.
    const { user } = renderWithUser(<PasswordInput aria-label="password" />);

    const field = screen.getByLabelText("password");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("data-clarity-mask", "true");

    await user.click(screen.getByRole("button", { name: /show password/i }));

    const revealed = screen.getByLabelText("password");
    expect(revealed).toHaveAttribute("type", "text");
    expect(revealed).toHaveAttribute("data-clarity-mask", "true");
  });

  it("never emits data-clarity-unmask, which fails open", () => {
    const { container } = renderWithUser(
      <>
        <Input aria-label="a" />
        <Textarea aria-label="b" />
        <PasswordInput aria-label="c" />
      </>,
    );
    expect(container.innerHTML).not.toContain("data-clarity-unmask");
  });

  it("cannot be switched off by a caller passing the attribute through", () => {
    // Props spread AFTER the literal would let a call site unmask a field.
    // If this ever fails, move `data-clarity-mask` below `{...props}`.
    renderWithUser(
      <Input
        aria-label="attacker"
        {...({ "data-clarity-mask": "false" } as Record<string, string>)}
      />,
    );
    expect(screen.getByLabelText("attacker")).toHaveAttribute(
      "data-clarity-mask",
      "true",
    );
  });
});
