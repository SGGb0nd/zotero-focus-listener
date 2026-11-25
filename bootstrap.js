/* Zotero Focus Listener: only existing horizontal neighbors. */
/* One-shot Zotero-only diagnostic. Observation never consumes events. */
function makeFocusTrace({startTimer, stopTimer, now, save, zone}) {
  let rows = [], pendingCtrl = [], timer = null, started = null, finished = false;
  const keys = new Set(["ControlLeft", "ControlRight", "KeyH", "KeyL"]);
  function flush() {
    if (finished || started === null) return;
    finished = true;
    if (timer !== null) stopTimer(timer);
    const head = "Focus Listener 1.0.3 | one shot | ms group edge code ctrl zone canceled";
    try { Promise.resolve(save(head + "\n" + rows.join("\n") + "\n")).catch(() => {}); }
    catch (_) {}
    rows = [];
    pendingCtrl = [];
  }
  function append(row, controlRelease = false) {
    if (finished || rows.length >= (controlRelease ? 72 : 68)) return;
    rows.push(row);
  }
  function observe(group, e) {
    try {
      if (finished || !e.isTrusted || !keys.has(e.code)) return;
      const here = zone();
      if (!here) return;
      const t = now();
      const entry = [group,e.type,e.code,+e.ctrlKey,here,+e.defaultPrevented].join(" ");
      if (started === null) {
        if (e.code.startsWith("Control")) {
          pendingCtrl.push([t,entry]);
          if (pendingCtrl.length > 4) pendingCtrl.shift();
          return;
        }
        if (!e.ctrlKey || e.type !== "keydown") return;
        started = t;
        rows = pendingCtrl.filter(([at]) => t-at < 1500).map(([at,line]) => (at-t)+" "+line);
        pendingCtrl = [];
        timer = startTimer(flush, 12000);
      }
      append((t-started)+" "+entry, e.type === "keyup" && e.code.startsWith("Control"));
    } catch (_) {}
  }
  function decision(e, outcome, from, dock) {
    try {
      if (finished || started === null || !e.isTrusted || !keys.has(e.code)) return;
      append([now()-started,"decision",e.code,outcome,from,zone() || "other",dock || "none"].join(" "));
    } catch (_) {}
  }
  return {observe, decision, flush};
}

// Window-local evidence for one Gecko modifier-loss episode. Never synthesize
// Ctrl or alter KeyboardEvent; only the existing pane router can use it.
function makeHeldControl(now) {
  const physical = new Set();
  const seen = new WeakSet();
  let owner = null, token = null, mode = null, deadline = 0;
  const ctrl = code => code === "ControlLeft" || code === "ControlRight";
  const letter = e => (e.code === "KeyH" && e.key === "h") ||
                      (e.code === "KeyL" && e.key === "l");
  function clear() { token = null; mode = null; deadline = 0; }
  function reset() { clear(); physical.clear(); owner = null; }
  function check(context) {
    if (!context || (owner && context !== owner)) reset();
    else if (mode && now() > deadline) reset();
  }
  function observe(e, context) {
    if (!e.isTrusted || seen.has(e)) return;
    seen.add(e);
    check(context);
    if (!context) return;
    if (ctrl(e.code)) {
      if (e.type === "keydown" && !e.repeat) {
        // A fresh modifier key begins a new physical interval, never inheriting
        // a stale recovery from a previously interrupted interval.
        if (!physical.has(e.code)) clear();
        owner = context;
        physical.add(e.code);
      } else if (e.type === "keyup") {
        physical.delete(e.code);
        clear(); // Even two physical Ctrl keys never share an old latch.
      }
      return;
    }
    if (!mode || !physical.size || e.altKey || e.metaKey || e.shiftKey ||
        e.isComposing || e.keyCode === 229) return;
    if (!e.ctrlKey && !letter(e) && e.type === "keydown") { reset(); return; }
    if (mode === "crossed" && !e.ctrlKey && letter(e)) {
      mode = "recovering";
      deadline = now()+4000; // not extended by later compensated repeats
    }
  }
  function crossed(e, context) {
    check(context);
    if (!context || !e.isTrusted || !e.ctrlKey || !physical.size || !letter(e)) return;
    token = context;
    mode = "crossed";
    deadline = now()+1000;
  }
  function applies(e, context) {
    check(context);
    return Boolean(mode === "recovering" && physical.size && token === context &&
      e.isTrusted && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey &&
      !e.isComposing && e.keyCode !== 229 && letter(e));
  }
  return {observe,crossed,applies,check,clear,reset};
}

function installFocusCoordinator(win) {
  const chromeDoc = win.document;
  let shadow = null, panel = null;
  const eventRoot = win.windowRoot;
  if (!eventRoot) return () => {};
  const handled = new WeakSet();
  const held = makeHeldControl(() => win.performance.now());
  const modalText = "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox]";
  const editable = node => node?.isContentEditable || Boolean(node?.closest?.(modalText));
  const frames = new Map();
  const mark = "data-local-zotero-focus-agent";
  const pdfMark = "data-local-zotero-focus-pdf";
  const css = "[data-local-zotero-focus-agent]{outline:1px solid light-dark(#7778,#aaa8)!important;outline-offset:-1px!important}";
  const pdfCss = "html[data-local-zotero-focus-pdf]::after{content:'';position:fixed;inset:0;box-shadow:inset 0 0 0 1px light-dark(#7778,#aaa8);z-index:2147483647;pointer-events:none}";
  let pending = 0, timer = 0;
  const styleIn = (doc, css) => {
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.textContent = css;
    (doc.head || doc.documentElement).appendChild(style);
    return style;
  };
  const panelStyle = styleIn(chromeDoc, css);
  function selected() {
    try {
      const id = win.Zotero_Tabs?.selectedID;
      const reader = id ? Zotero.Reader.getByTabID(id) : null;
      if (!reader || reader.type !== "pdf") return null;
      const ir = reader._internalReader;
      return reader._iframe && ir ? { reader, ir, p: ir._primaryView?._iframeWindow, s: ir._secondaryView?._iframeWindow } : null;
    } catch (_) { return null; }
  }
  function side(ctx) {
    if (!ctx || !panel?.isConnected || panel.hidden) return null;
    const a = panel.getBoundingClientRect(), b = ctx.reader._iframe.getBoundingClientRect();
    if (!a.width || !a.height || !b.width || !b.height ||
        Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top)) return null;
    if (a.right <= b.left + 4) return "left";
    if (a.left >= b.right - 4) return "right";
    return null;
  }
  function direction(e, recover = false) {
    if (!e.isTrusted || e.isComposing || e.keyCode === 229 ||
        (!e.ctrlKey && !recover) || e.metaKey || e.altKey || e.shiftKey) return null;
    return e.key === "h" ? "left" : e.key === "l" ? "right" : null;
  }
  function focused(view) {
    try {
      // XUL reader chrome and PDF frames are separate focus contexts.
      return Boolean(view?.document?.hasFocus() || Services.focus?.focusedWindow === view);
    } catch (_) { return false; }
  }
  function draw() {
    pending = 0;
    const ctx = selected();
    const active = chromeDoc.hasFocus();
    const agentActive = Boolean(active && !panel?.hidden && shadow?.activeElement);
    panel?.toggleAttribute(mark, agentActive);
    for (const [view, item] of frames) {
      const inside = Boolean(active && !agentActive &&
        (view === ctx?.p || view === ctx?.s) && focused(view));
      item.doc.documentElement.toggleAttribute(pdfMark, inside);
    }
  }
  function schedule() {
    if (!pending) pending = win.requestAnimationFrame(draw);
  }
  const focusChanged = () => schedule();

  function watchView(view) {
    if (!view || frames.has(view)) return;
    let doc;
    try { doc = view.document; } catch (_) { return; }
    if (!doc?.documentElement) return;
    const st = styleIn(doc, pdfCss);
    for (const type of ["focus", "blur", "focusin", "focusout"]) view.addEventListener(type, focusChanged, true);
    const remove = () => {
      for (const type of ["focus", "blur", "focusin", "focusout"]) view.removeEventListener(type,focusChanged,true);
      doc.documentElement?.removeAttribute(pdfMark);
      st.remove();
    };
    frames.set(view,{ doc,remove });
  }
  function refresh() {
    const nextPanel = chromeDoc.getElementById("zmc-panel");
    const nextShadow = chromeDoc.getElementById("zmc-root")?.shadowRoot || null;
    if (nextPanel !== panel) panel?.removeAttribute(mark);
    shadow = nextShadow;
    panel = nextPanel;
    const ctx = selected();
    held.check(ctx?.reader);
    const keep = new Set([ctx?.p,ctx?.s].filter(Boolean));
    for (const [view,item] of frames) {
      let current;
      try { current = view.document; } catch (_) {}
      if (!keep.has(view) || item.doc !== current) {
        item.remove();
        frames.delete(view);
      }
    }
    for (const view of keep) watchView(view);
    schedule();
  }
  function focusPDF(ctx, target) {
    if (!target) return false;
    try {
      ctx.reader._iframe.focus({preventScroll:true});
      target.frameElement?.focus({preventScroll:true});
      target.focus();
      target.document.querySelector("#viewerContainer")?.focus({preventScroll:true});
      return !shadow?.activeElement && focused(target);
    } catch (_) { return false; }
  }
  function focusPDFDirect(target, report) {
    try {
      const doc = target?.document;
      const viewer = doc?.getElementById("viewerContainer");
      if (!viewer?.isConnected || !viewer.getClientRects().length) {
        report("native-unavailable");
        return false;
      }
      report("native-before");
      // Do not focus the XUL browser or either intermediate window.
      Services.focus.setFocus(viewer, Ci.nsIFocusManager.FLAG_NOSCROLL);
      const moved = !shadow?.activeElement && focused(target) && doc.activeElement === viewer;
      report(moved ? "native-after-ok" : "native-after-failed");
      return moved;
    } catch (_) {
      report("native-error");
      return false;
    }
  }
  function focusAgent() {
    if (!shadow) return false;
    const visible = node => !node.disabled && node.getClientRects().length
      && win.getComputedStyle(node).visibility === "visible";
    // Agent can be on a welcome/settings view without a displayed composer.
    const composer = shadow.querySelector("textarea.cin");
    const target = composer && visible(composer) ? composer
      : Array.from(shadow.querySelectorAll("button,textarea,input,select,a[href],[tabindex]"))
        .find(node => node.tabIndex >= 0 && visible(node));
    if (!target) return false;
    target.focus({preventScroll:true});
    return shadow.activeElement === target;
  }
  function navigate(e, origin, dir, recovered) {
    if (handled.has(e) || e.defaultPrevented) return;
    // Ctrl can have gone down in another frame. Read this chord's trusted modifier.
    const ctx = selected(), dock = side(ctx);
    if (!dir || !ctx) return;
    const from = origin === "agent" ? "agent" : origin === ctx.p ? "pdf-a" : "pdf-b";
    const note = outcome => trace.decision(e, outcome, from, dock);
    const vertical = ctx.ir.splitType === "vertical" && ctx.s;
    let moved = false, attempted = false;
    if (origin === "agent") {
      if (!shadow?.activeElement || !dock) { held.clear(); note("pass-agent-unavailable"); return; }
      attempted = dock !== dir;
      moved = dock !== dir && focusPDFDirect(vertical && dock === "right" ? ctx.s
        : ctx.ir.splitType === "horizontal" && ctx.s && ctx.ir._lastView?._iframeWindow === ctx.s ? ctx.s : ctx.p, note);
    } else {
      const doc = origin.document;
      if ((origin !== ctx.p && origin !== ctx.s) || shadow?.activeElement || !focused(origin) ||
          editable(e.composedPath?.()[0] || e.target) || editable(doc.activeElement) ||
          doc.querySelector("dialog[open],[role=dialog][aria-modal=true]:not([hidden])")) { held.clear(); note("pass-reader-guard"); return; }
      // With upstream Vim, do not commandeer its visual/insert mode, pending
      // chords or picker. Normal mode lacks this indicator or has progress only.
      const indicator = ctx.reader._iframeWindow?.document?.getElementById("zotero-vim-mode-indicator");
      if (indicator?.style.display !== "none" && /^--\s+[A-Z]+\s+--/.test(indicator?.textContent || "")) return;
      const peer = vertical && (dir === "right" && origin === ctx.p ? ctx.s
        : dir === "left" && origin === ctx.s ? ctx.p : null);
      if (peer) { attempted = true; moved = focusPDF(ctx, peer); }
      else if (dir === dock) { attempted = true; moved = focusAgent(); }
    }
    // These two chords in a managed pane are ours, including at an edge.
    // Never allow Vim to repeat the move or redirect a no-neighbor chord.
    if (!moved && attempted) held.clear();
    if (moved && origin === "agent") held.crossed(e, ctx.reader);
    if (!moved && origin === "agent" && dock !== dir) { note("pass-focus-failed"); return; }
    if (!moved && attempted && recovered) return;
    if (recovered) note("physical-control-recovery");
    note(moved ? "claim-moved" : "claim-edge");
    handled.add(e);
    e.preventDefault();
    e.stopImmediatePropagation();
    schedule();
  }
  // The chrome WindowRoot sits before the PDF leaf Window's default
  // capture, where Vim handles its bindings. One arbiter owns the chord.
  const trace = makeFocusTrace({
    startTimer: (cb,ms) => win.setTimeout(cb,ms),
    stopTimer: id => win.clearTimeout(id),
    now: () => Math.round(win.performance.now()),
    zone: () => {
      const ctx = selected();
      if (!ctx || !chromeDoc.hasFocus()) return null;
      if (shadow?.activeElement) return "agent";
      if (focused(ctx.p)) return "pdf-a";
      if (focused(ctx.s)) return "pdf-b";
      return null;
    },
    save: text => {
      const file = PathUtils.join(Zotero.Profile.dir,"focus-listener-diagnostic.log");
      return IOUtils.writeUTF8(file,text,{tmpPath:file+".tmp",mode:"overwrite"});
    },
  });
  const observeHeld = e => held.observe(e,chromeDoc.hasFocus() ? selected()?.reader : null);
  const diagnosticDefaultUp = e => { observeHeld(e); trace.observe("default",e); };
  const diagnosticSystem = e => { observeHeld(e); trace.observe("system",e); };
  const resetHeld = () => held.reset();
  const deactivateHeld = e => { if (e.target === win || e.target === chromeDoc) resetHeld(); };
  const visibilityReset = () => { if (chromeDoc.hidden) resetHeld(); };
  const systemCapture = {capture:true,mozSystemGroup:true};
  const rootKey = e => {
    observeHeld(e);
    trace.observe("default", e);
    if (!chromeDoc.hasFocus()) return;
    const ctx = selected();
    if (!ctx) return;
    const recovered = held.applies(e,ctx.reader);
    const dir = direction(e,recovered);
    if (!dir) return;
    if (shadow?.activeElement) {
      if (e.composedPath?.().includes(shadow.host)) navigate(e, "agent",dir,recovered);
      else if (recovered) held.clear();
      return;
    }
    const actual = Services.focus?.focusedWindow;
    const leaf = [ctx.p,ctx.s].find(view => view && view === actual)
      || [ctx.p,ctx.s].find(view => view && focused(view));
    if (leaf) navigate(e, leaf,dir,recovered);
    else if (recovered) held.clear();
  };
  win.addEventListener("deactivate",deactivateHeld);
  chromeDoc.addEventListener("visibilitychange",visibilityReset);
  eventRoot.addEventListener("keydown", rootKey, true);
  eventRoot.addEventListener("keyup", diagnosticDefaultUp, true);
  eventRoot.addEventListener("keydown", diagnosticSystem, systemCapture);
  eventRoot.addEventListener("keyup", diagnosticSystem, systemCapture);
  for (const type of ["focus", "blur", "focusin", "focusout"]) win.addEventListener(type, focusChanged,true);
  const observer = Zotero.Notifier.registerObserver({notify: refresh}, ["tab"], "local-zotero-focus-listener");
  const mutations = new win.MutationObserver(refresh);
  mutations.observe(chromeDoc.getElementById("tabs-deck")?.parentElement || chromeDoc.documentElement, {childList:true});
  timer = win.setInterval(refresh, 350);
  refresh();
  return () => {
    if (pending) win.cancelAnimationFrame(pending);
    win.clearInterval(timer);
    mutations.disconnect();
    if (observer != null) Zotero.Notifier.unregisterObserver(observer);
    win.removeEventListener("deactivate",deactivateHeld);
    chromeDoc.removeEventListener("visibilitychange",visibilityReset);
    resetHeld();
    eventRoot.removeEventListener("keydown", rootKey, true);
    eventRoot.removeEventListener("keyup", diagnosticDefaultUp, true);
    eventRoot.removeEventListener("keydown", diagnosticSystem, systemCapture);
    eventRoot.removeEventListener("keyup", diagnosticSystem, systemCapture);
    trace.flush();
    for (const type of ["focus", "blur", "focusin", "focusout"]) win.removeEventListener(type,focusChanged,true);
    for (const item of frames.values()) item.remove();
    frames.clear();
    panel?.removeAttribute(mark);
    panelStyle.remove();
  };
}

const activeFocusWindows = new Map();
let focusListenerStarted = false;
function installForWindow(window) {
  if (!focusListenerStarted || activeFocusWindows.has(window) || !window?.Zotero_Tabs) return;
  try { activeFocusWindows.set(window, installFocusCoordinator(window)); }
  catch (error) { Zotero.logError(error); }
}
async function startup() {
  focusListenerStarted = true;
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  if (focusListenerStarted) {
    for (const window of Zotero.getMainWindows()) installForWindow(window);
  }
}
function onMainWindowLoad({ window }) { installForWindow(window); }
function onMainWindowUnload({ window }) {
  const dispose = activeFocusWindows.get(window);
  activeFocusWindows.delete(window);
  dispose?.();
}
function shutdown() {
  focusListenerStarted = false;
  for (const window of activeFocusWindows.keys()) onMainWindowUnload({window});
}
function install() {}
function uninstall() {}
