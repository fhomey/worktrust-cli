/**
 * PERSONAL TEMPLATES (docs/remote-agents/MAIL.md §Personal templates; rule 3, OpenClaw rule 5). An automation is a plain
 * sentence the person confirmed (`when`) and actions from a CLOSED list: label, archive, draft. NEVER SEND: sending is
 * mail.send alone, approved on the phone for one message (remote-mail-outbox.mjs). check-remote-cli rule X refuses `send`
 * here, in the protocol's list and in any code that runs a template.
 *
 * A new or changed template runs ONCE at once as a visible test: with a draft action it asks the drafter for a draft of the
 * newest matching thread (a draft only, shown on the phone), otherwise it does nothing and says `skipped`. Every run is
 * logged with its reason, by ids. ON NEW MAIL (createAutomations, owner 2026-11-24) each enabled template asks the person's
 * own agent, with no tools, whether its sentence fits each new message (a verdict: yes or no), and where it does it labels,
 * archives or drafts, nothing else; every run leaves its result on the template (ok, failed, skipped) for the phone.
 */
import { existsSync } from "node:fs";
import * as P from "./remote-protocol.mjs";
import { readMailFile, writeMailFile } from "./remote-mail-files.mjs";

/** The actions a template may take, and nothing else. */
export const TEMPLATE_ACTIONS = Object.freeze(["label", "archive", "draft"]);
export const templateActionOk = (action) => TEMPLATE_ACTIONS.includes(action) && P.MAIL_TEMPLATE_ACTIONS.includes(action);

/** o: { file, now, random, log } */
export function createTemplates(o) {
  let list = [];
  try { if (existsSync(o.file)) list = (JSON.parse(readMailFile(o.file)).templates ?? []).filter((t) => t.actions.every(templateActionOk)); } catch { list = []; }
  const save = () => writeMailFile(o.file, JSON.stringify({ v: 1, templates: list }));
  return {
    all: () => list.slice(),
    get: (id) => list.find((t) => t.template_id === id) ?? null,
    /** → { ok: true, template, removed? } or { ok: false, code }: not_found, limit, not_allowed. */
    set(payload) {
      if (!payload.actions.every(templateActionOk)) { o.log("template_refused", { reason: "action" }); return { ok: false, code: "not_allowed" }; }
      const held = payload.template_id ? list.find((t) => t.template_id === payload.template_id) : null;
      if (payload.template_id && !held) return { ok: false, code: "not_found" };
      if (payload.remove === true) { list = list.filter((t) => t.template_id !== held.template_id); save(); o.log("template_removed", { template_id: held.template_id }); return { ok: true, template: { ...held, enabled: false }, removed: true }; }
      if (!held && list.length >= P.MAIL_TEMPLATES_MAX) return { ok: false, code: "limit" };
      const template = {
        template_id: held?.template_id ?? P.mintId("tpl", o.random), kind: "email", title: payload.title, when: payload.when, actions: [...payload.actions],
        label: payload.label ?? null, account_id: payload.account_id ?? null, enabled: payload.enabled, last_run_at: held?.last_run_at ?? null, last_result: held?.last_result ?? null,
      };
      list = [...list.filter((t) => t.template_id !== template.template_id), template];
      save();
      o.log("template_set", { template_id: template.template_id, actions: template.actions.join(",") });
      return { ok: true, template };
    },
    /** The run's outcome, kept on the template (ok, failed, test_draft, skipped) with its time. */
    ran(id, result) {
      list = list.map((t) => (t.template_id === id ? { ...t, last_run_at: o.now(), last_result: result } : t));
      save();
      o.log("template_run", { template_id: id, result });
      return list.find((t) => t.template_id === id) ?? null;
    },
  };
}

/** The most new messages one sync hands the automations (the newest first): a flood is never fed to an agent whole. */
export const AUTOMATION_BATCH = 5;
/**
 * TEMPLATES RUN BY THEMSELVES ON NEW MAIL. o: { templates, index, verdict(row, when) → { ok, verdict } | { ok: false },
 * draft(account, row) → Promise<boolean> (a draft only, shown on the phone), told(template) (the template pushed to the phones),
 * log }. → run(account, rows), one run at a time. The only acts are label, archive and draft: a send has no path from here.
 */
export function createAutomations(o) {
  let tail = Promise.resolve();
  async function once(account, rows) {
    const list = o.templates.all().filter((t) => t.enabled && (t.account_id === null || t.account_id === account.account_id));
    const batch = [...rows].sort((a, b) => b.date - a.date).slice(0, AUTOMATION_BATCH);
    for (const t of list) {
      let result = "skipped";
      for (const row of batch) {
        const v = await o.verdict(row, t.when).catch(() => ({ ok: false }));
        if (!v.ok) { result = "failed"; o.log("template_verdict", { template_id: t.template_id, outcome: "failed" }); continue; }
        if (!v.verdict.applies) continue;
        let done = true;
        for (const action of t.actions) {
          if (!templateActionOk(action)) { done = false; continue; }
          if (action === "label" && t.label) o.index.flag(row.thread_id, { addLabel: t.label });
          else if (action === "archive") o.index.flag(row.thread_id, { archive: true });
          else if (action === "draft") done = (await o.draft(account, row).catch(() => false)) && done;
        }
        result = done && result !== "failed" ? "ok" : "failed";
        o.log("template_applied", { template_id: t.template_id, actions: t.actions.join(","), outcome: done ? "ok" : "failed" });
      }
      const after = o.templates.ran(t.template_id, result);
      if (after) o.told(after);
    }
  }
  return { run: (account, rows) => (tail = tail.then(() => once(account, rows)).catch(() => o.log("template_run", { outcome: "failed" }))) };
}
