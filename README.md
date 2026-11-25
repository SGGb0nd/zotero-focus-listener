# Zotero Focus Listener

A standalone Zotero add-on that moves keyboard focus left or right between already-open PDF and Zotero Agent panes with Ctrl+H and Ctrl+L. It does not create or close panes or modify Zotero Vim or Zotero Agent.

## Install

Download the XPI from [Releases](https://github.com/SGGb0nd/zotero-focus-listener/releases), then in Zotero choose Tools → Plugins → gear menu → Install Add-on From File. The existing manifest declares Zotero 8 through 10; this does not imply all combinations have been tested. Builds are published as prereleases. In particular, verification of repeated switches with Ctrl held on real Wayland and verification on macOS are pending.

The current build includes a short, one-shot diagnostic that records Ctrl/H/L event metadata while a Zotero reader or agent pane has focus. It writes only to a local diagnostic log in the Zotero profile. The diagnostic does not send telemetry.
