import { describe, expect, it } from "vitest";

import {
  EMAIL_VARIABLES,
  availableVariables,
  extractVariables,
  findVariable,
  groupedVariables,
  manualVariablesUsed,
  renderVariables,
  sampleValues,
  variableToken,
} from "@/lib/constants/email-variables";

describe("variable registry", () => {
  it("has no duplicate tokens", () => {
    const tokens = EMAIL_VARIABLES.map((v) => v.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("gives every variable a sample, so no preview renders a blank", () => {
    for (const v of EMAIL_VARIABLES) expect(v.sample.trim()).not.toBe("");
  });

  it("writes the wire form the editor inserts", () => {
    expect(variableToken("client_name")).toBe("{{client_name}}");
  });
});

describe("availableVariables", () => {
  it("offers client + business on every send", () => {
    const tokens = availableVariables({ order: false, payment: false }).map(
      (v) => v.token,
    );
    expect(tokens).toContain("client_name");
    expect(tokens).toContain("business_name");
  });

  it("withholds order fields until the email has an order", () => {
    const without = availableVariables({ order: false, payment: false }).map(
      (v) => v.token,
    );
    expect(without).not.toContain("order_name");

    const withOrder = availableVariables({ order: true, payment: false }).map(
      (v) => v.token,
    );
    expect(withOrder).toContain("order_name");
    // An order without an invoice still can't resolve a payment link.
    expect(withOrder).not.toContain("payment_link");
  });

  it("unlocks invoice fields only when there is payment data", () => {
    const tokens = availableVariables({ order: true, payment: true }).map(
      (v) => v.token,
    );
    expect(tokens).toContain("invoice_number");
    expect(tokens).toContain("payment_link");
  });

  it("always offers the operator-supplied variables — that's the point of them", () => {
    const tokens = availableVariables({ order: false, payment: false }).map(
      (v) => v.token,
    );
    expect(tokens).toContain("meeting_link");
    expect(tokens).toContain("project_update");
  });

  it("drops empty groups from the menu", () => {
    const groups = groupedVariables({ order: false, payment: false }).map(
      (g) => g.group,
    );
    expect(groups).not.toContain("order");
    expect(groups).not.toContain("invoice");
    expect(groups).toContain("client");
  });
});

describe("extractVariables", () => {
  it("finds tokens across subject and body, first-seen order, de-duplicated", () => {
    expect(
      extractVariables(
        "Update on {{order_name}}",
        "Hi {{client_name}}, re {{order_name}}.",
      ),
    ).toEqual(["order_name", "client_name"]);
  });

  it("tolerates inner whitespace", () => {
    expect(extractVariables("{{ client_name }}")).toEqual(["client_name"]);
  });

  it("ignores tokens that aren't ours", () => {
    expect(extractVariables("{{not_a_variable}}")).toEqual([]);
  });
});

describe("manualVariablesUsed", () => {
  it("asks only for what the copy actually uses", () => {
    // A meeting invite needs meeting fields; it must not be asked for a
    // project status line just because that variable exists.
    const meeting = manualVariablesUsed(
      "Call on {{meeting_date}}",
      "Join at {{meeting_link}}.",
    ).map((v) => v.token);
    expect(meeting.sort()).toEqual(["meeting_date", "meeting_link"]);

    const update = manualVariablesUsed(
      "Weekly update",
      "{{project_update}} Next: {{next_step}}",
    ).map((v) => v.token);
    expect(update.sort()).toEqual(["next_step", "project_update"]);
  });

  it("never asks for something the server resolves", () => {
    expect(manualVariablesUsed("Hi {{client_name}} re {{order_id}}")).toEqual([]);
  });
});

describe("renderVariables", () => {
  it("substitutes resolved values", () => {
    expect(
      renderVariables("Hello {{client_name}}, re {{order_name}}.", {
        client_name: "Jane",
        order_name: "Website Development",
      }),
    ).toBe("Hello Jane, re Website Development.");
  });

  it("collapses an unresolved KNOWN token to empty — never leaks syntax to a customer", () => {
    expect(renderVariables("Ref: {{invoice_number}}.", {})).toBe("Ref: .");
    expect(renderVariables("Ref: {{invoice_number}}.", { invoice_number: null })).toBe(
      "Ref: .",
    );
  });

  it("leaves unknown braces alone — they're the operator's literal copy", () => {
    expect(renderVariables("Use {{handlebars}} in your docs", {})).toBe(
      "Use {{handlebars}} in your docs",
    );
  });

  it("handles repeated tokens and inner whitespace", () => {
    expect(
      renderVariables("{{ client_name }} & {{client_name}}", {
        client_name: "Jane",
      }),
    ).toBe("Jane & Jane");
  });

  it("does not re-expand a value that itself looks like a token", () => {
    // A client literally named "{{business_name}}" must not become the
    // business name — one substitution pass, no recursion.
    expect(
      renderVariables("Hi {{client_name}}", {
        client_name: "{{business_name}}",
        business_name: "Northwind",
      }),
    ).toBe("Hi {{business_name}}");
  });
});

describe("sampleValues", () => {
  it("covers every registry token so a preview is never half-blank", () => {
    const samples = sampleValues();
    for (const v of EMAIL_VARIABLES) {
      expect(samples[v.token]).toBe(v.sample);
    }
  });

  it("renders a full template with nothing left unresolved", () => {
    const body =
      "Hi {{client_name}}, {{order_name}} is {{order_status}}. Pay: {{payment_link}}";
    const out = renderVariables(body, sampleValues());
    expect(out).not.toContain("{{");
    expect(out).toContain(findVariable("client_name")!.sample);
  });
});
