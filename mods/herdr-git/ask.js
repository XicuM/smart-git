// Dialogs: a menu at the pointer, a list of choices, or a text input, answered as a promise.
// The overlay is this same mod with props.view "ask"; main.js draws it with `Ask`.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor } from "gpui-base";
import { props, theme, settings, openOverlay, closeOverlay } from "herdr";

// A key as lazygit's keymap spells it: "a", "A", "space", "ctrl-d", "`".
const NAMED = ["enter", "escape", "tab", "backspace", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "space"];
export function keyOf(e) {
  const m = e.modifiers ?? {};
  if (m.control || m.alt || m.platform) return e.keystroke;
  if (NAMED.includes(e.key)) return (m.shift ? "shift-" : "") + e.key;
  return e.key_char ?? e.key;
}

// Dialogs answer through module scope, which every copy of this mod shares.
const replies = new Map();
let asked = 0;
export function ask(spec) {
  const id = `ask-${++asked}`;
  // A menu ({ menu: true, items }) opens at the pointer, sized to its rows.
  const size = spec.menu
    ? { kind: "popup", width: 300, height: Math.min(640, 14 + (spec.title ? 26 : 0) + spec.items.length * 30) }
    : { kind: "dialog", width: 460 };
  return new Promise((resolve) => {
    replies.set(id, resolve);
    openOverlay({ mod: "herdr-git", ...size, props: { view: "ask", id, ...spec } });
  });
}
const reply = (id, value) => { replies.get(id)?.(value); replies.delete(id); };
export const confirm = (title, detail, label, danger = true) => ask({ title, detail, items: [{ key: "enter", label, value: true, danger }] });


// A dialog: a menu (items with keys) or a text input, answering the promise ask() made.
export class Ask {
  constructor(cx) {
    const p = props();
    this.handle = cx.focus_handle(); this.sel = 0;
    if (p.input) {
      this.input = InputState.new({ value: p.input.value ?? "", placeholder: p.input.placeholder ?? "" });
      this.input.on("submit", () => this.done({ text: this.input.value(), description: this.desc?.value() ?? "" }));
      this.input.focus();
      cx.timer.after(150, () => this.input.focus());
      if (p.description) this.desc = EditorState.new({ value: p.descriptionValue ?? "", line_numbers: false, folding: false, soft_wrap: true, font_family: settings().font_family });
    } else { this.handle.focus(); cx.timer.after(150, () => this.handle.focus()); }
  }

  done(value) { const p = props(); reply(p.id, value); closeOverlay(p.overlay); }
  close() { reply(props()?.id, null); }

  key(e, cx) {
    const p = props(), items = p.items ?? [], k = keyOf(e);
    if (k === "escape") return this.done(null);
    if (this.input) {
      if (k === "tab" && this.desc) { this.desc.focus(); cx.stop_propagation(); }
      if (k === "shift-tab") { this.input.focus(); cx.stop_propagation(); }
      if (e.keystroke === "ctrl-enter" || e.keystroke === "cmd-enter") this.done({ text: this.input.value(), description: this.desc?.value() ?? "" });
      return;
    }
    const hit = items.find((i) => i.key === k && k !== "enter");
    if (hit) return this.done(hit.value);
    if (k === "j" || k === "down") this.sel = Math.min(this.sel + 1, items.length - 1);
    else if (k === "k" || k === "up") this.sel = Math.max(this.sel - 1, 0);
    else if (k === "enter" || k === "space") return this.done(items[this.sel]?.value ?? null);
    else return;
    cx.stop_propagation(); cx.notify();
  }

  render(cx) {
    const t = theme(), p = props() ?? {}, items = p.items ?? [];
    // A right-click menu: compact rows like Herdr's own menu, each with its key on the right.
    if (p.menu) return v_flex().id("herdr-git-menu").w_full().max_h(640).p(5).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .when(Boolean(p.title), (e) => e.child(div().h(26).flex_none().px(8).flex().items_center().text_size(11.5).text_color(t.dim).truncate().child(p.title)))
      .child(v_flex().id("items").flex_shrink().min_h(0).overflow_y_scroll().children(items.map((item, n) => h_flex().id(`item-${n}`).h(30).flex_none().px(8).gap(9).items_center().rounded(7).cursor_pointer()
        .when(n === this.sel, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click(() => this.done(item.value))
        .child(div().flex_1().min_w(0).truncate().text_color(item.danger ? t.ansi1 : t.foreground).child(item.label))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(item.key)))));
    return v_flex().id("herdr-git-ask").w_full().max_h(620).p(p.menu ? 6 : 16).gap(p.menu ? 0 : 10).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .when(Boolean(p.title), (e) => e.child(div().font_semibold().when(Boolean(p.menu), (e) => e.px(8).h(26).text_size(12).text_color(t.muted).flex().items_center()).child(p.title)))
      .when(Boolean(p.detail), (e) => e.child(div().text_size(12).text_color(t.muted).child(p.detail)))
      .when(Boolean(this.input), (e) => e.child(div().h(32).px(10).flex().items_center().rounded(7).border_1().border_color(t.accent)
        .child(Input.new(this.input).h_full().text_size(13))))
      .when(Boolean(this.desc), (e) => e.child(div().h(120).rounded(7).border_1().border_color(t.input).overflow_hidden().child(Editor.new(this.desc).size_full()))
        .child(div().text_size(11).text_color(t.dim).child(p.descriptionHint ?? "enter commit · tab description · ctrl-enter commit from description · esc cancel")))
      .child(v_flex().id("items").flex_shrink().min_h(0).overflow_y_scroll().children(items.map((item, n) => h_flex().id(`item-${n}`).h(28).flex_none().px(8).gap(10).items_center().rounded(6).cursor_pointer()
        .when(n === this.sel, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click(() => this.done(item.value))
        .child(div().min_w(18).flex_none().text_color(t.accent).text_size(12).child(item.key === "enter" ? "⏎" : item.key))
        .child(div().flex_1().min_w(0).truncate().text_color(item.danger ? t.ansi1 : t.foreground).child(item.label)))));
  }
}
