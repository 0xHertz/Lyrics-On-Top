import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const LYRICS_FRESHNESS_SECONDS = 15;
const VISIBILITY_CHECK_INTERVAL_MS = 2000;

export default class LyricsExtension extends Extension {
  enable() {
    this._destroyed = false;

    // =========================
    // State
    // =========================

    this._floatingLyricsEnabled = true;

    this._hasMprisPlayer = false;

    this._hasPlayingPlayer = false;

    this._lastLyricsTimestampUs = 0;
    this._overviewTransitioning = false;

    // =========================
    // Panel button
    // =========================

    this._panelLabel = new St.Label({
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "panel-status-menu-box",
    });

    this._panelButton = new St.Button({
      child: this._panelLabel,
      reactive: true,
      can_focus: true,
      track_hover: true,
    });

    const panelBox =
      Main.panel?.statusArea?.aggregateMenu?.container ?? Main.panel?._leftBox;

    panelBox?.insert_child_at_index(this._panelButton, 2);

    // =========================
    // Menu
    // =========================

    this._menuManager = new PopupMenu.PopupMenuManager(this);

    this._menu = new PopupMenu.PopupMenu(this._panelButton, 0, St.Side.TOP);

    this._menuManager.addMenu(this._menu);

    Main.uiGroup.add_child(this._menu.actor);

    this._menu.actor.hide();

    this._menu._boxPointer.setSourceAlignment(0);

    this._floatingLyricsToggle = new PopupMenu.PopupSwitchMenuItem(
      "显示悬浮歌词",
      this._floatingLyricsEnabled,
    );

    this._floatingLyricsToggle.connect("toggled", (_item, enabled) => {
      this._floatingLyricsEnabled = enabled;

      this._syncUi();
    });

    this._menu.addMenuItem(this._floatingLyricsToggle);

    this._panelButton.connect("clicked", () => {
      this._menu.toggle();
    });

    // =========================
    // Floating lyrics
    // =========================

    this._createFloatingLyrics();

    // =========================
    // Signals
    // =========================

    this._signalIds = [];

    const topPanelBox = Main.layoutManager.panelBox;

    this._signalIds.push([
      topPanelBox,
      topPanelBox.connect("notify::visible", () => this._syncUi()),
    ]);

    const overview = Main.overview;

    // for (const signal of ["showing", "shown", "hiding", "hidden"]) {
    //   this._signalIds.push([
    //     overview,
    //     overview.connect(signal, () => this._syncUi()),
    //   ]);
    // }

    const controls = overview?._overview?.controls;

    if (controls) {
      this._signalIds.push([
        controls,
        controls.connect("notify::progress", () => {
          const progress = controls.progress;

          this._overviewTransitioning = progress > 0 && progress < 1;

          this._syncUi();
        }),
      ]);
    }

    // =========================
    // Periodic visibility sync
    // =========================

    this._visibilityCheckId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      VISIBILITY_CHECK_INTERVAL_MS,
      () => {
        this._syncUi();

        return !this._destroyed;
      },
    );

    // =========================
    // MPRIS
    // =========================

    this._subscribeToPlayerChanges();

    this._refreshPlaybackState();

    // =========================
    // Lyrics
    // =========================

    this._startLyricsProcess();

    // =========================
    // Initial sync
    // =========================

    this._initialSyncTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      500,
      () => {
        this._syncUi();

        this._initialSyncTimeoutId = null;

        return GLib.SOURCE_REMOVE;
      },
    );
  }

  disable() {
    this._destroyed = true;

    // =========================
    // Timers
    // =========================

    if (this._initialSyncTimeoutId) {
      GLib.source_remove(this._initialSyncTimeoutId);

      this._initialSyncTimeoutId = null;
    }

    if (this._visibilityCheckId) {
      GLib.source_remove(this._visibilityCheckId);

      this._visibilityCheckId = null;
    }

    // =========================
    // DBus
    // =========================

    if (this._playerSignalId) {
      Gio.DBus.session.signal_unsubscribe(this._playerSignalId);

      this._playerSignalId = null;
    }

    // =========================
    // Signals
    // =========================

    for (const [object, id] of this._signalIds ?? []) {
      try {
        object.disconnect(id);
      } catch {}
    }

    this._signalIds = null;
    if (this._nameOwnerSignalId) {
      Gio.DBus.session.signal_unsubscribe(this._nameOwnerSignalId);

      this._nameOwnerSignalId = null;
    }

    // =========================
    // Subprocess
    // =========================

    if (this._lyricsProcess) {
      try {
        this._lyricsProcess.force_exit();
      } catch {}
    }

    this._lyricsProcess = null;

    this._lyricsStream = null;

    // =========================
    // UI
    // =========================

    this._menu?.destroy();
    this._menu = null;

    this._panelButton?.destroy();
    this._panelButton = null;

    this._floatingLyricsBox?.destroy();
    this._floatingLyricsBox = null;

    this._panelLabel = null;
    this._floatingLyricsLabel = null;
  }

  // =========================================================
  // UI
  // =========================================================

  _createFloatingLyrics() {
    this._floatingLyricsLabel = new St.Label({
      text: "",
      style_class: "lyrics-floating-label",
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._floatingLyricsBox = new St.BoxLayout({
      style_class: "lyrics-floating-box",
      reactive: false,
    });

    this._floatingLyricsBox.add_child(this._floatingLyricsLabel);

    this._floatingLyricsBox.add_constraint(
      new Clutter.AlignConstraint({
        source: global.stage,
        align_axis: Clutter.AlignAxis.X_AXIS,
        factor: 0.5,
      }),
    );

    this._floatingLyricsBox.add_constraint(
      new Clutter.AlignConstraint({
        source: global.stage,
        align_axis: Clutter.AlignAxis.Y_AXIS,
        factor: 0,
      }),
    );

    Main.layoutManager.addChrome(this._floatingLyricsBox, {
      affectsStruts: false,
      trackFullscreen: true,
    });

    this._floatingLyricsBox.set_y(40);

    this._floatingLyricsBox.hide();
  }

  _isTopBarVisible() {
    const controls = Main.overview?._overview?.controls;

    if (controls && controls.progress > 0) {
      return true;
    }

    const panelBox = Main.layoutManager.panelBox;

    return !!(
      panelBox &&
      panelBox.visible &&
      panelBox.height > 0 &&
      panelBox.opacity > 0
    );
  }

  _hasFreshLyrics() {
    const ageSeconds =
      (GLib.get_monotonic_time() - this._lastLyricsTimestampUs) / 1000000;

    return ageSeconds < LYRICS_FRESHNESS_SECONDS;
  }

  _syncUi() {
    if (this._overviewTransitioning) {
      this._panelButton.hide();
      this._floatingLyricsBox.hide();

      return;
    }
    if (this._destroyed || !this._panelButton || !this._floatingLyricsBox) {
      return;
    }

    this._panelButton.hide();

    this._floatingLyricsBox.hide();

    const shouldShowLyrics =
      this._hasMprisPlayer && this._hasPlayingPlayer && this._hasFreshLyrics();

    if (!shouldShowLyrics) {
      return;
    }

    if (this._isTopBarVisible()) {
      this._panelButton.show();
    } else if (this._floatingLyricsEnabled) {
      this._floatingLyricsBox.show();
    }
  }

  // =========================================================
  // MPRIS
  // =========================================================

  _subscribeToPlayerChanges() {
    this._playerSignalId = Gio.DBus.session.signal_subscribe(
      null,
      "org.freedesktop.DBus.Properties",
      "PropertiesChanged",
      null,
      null,
      Gio.DBusSignalFlags.NONE,
      () => {
        this._refreshPlaybackState();
      },
    );

    this._nameOwnerSignalId = Gio.DBus.session.signal_subscribe(
      "org.freedesktop.DBus",
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      null,
      Gio.DBusSignalFlags.NONE,
      () => {
        this._refreshPlaybackState();
      },
    );

    this._refreshPlaybackState();
  }

  _refreshPlaybackState() {
    Gio.DBus.session.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListNames",
      null,
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (connection, result) => {
        if (this._destroyed) {
          return;
        }

        try {
          const response = connection.call_finish(result);

          const [names] = response.deep_unpack();

          const playerNames = names.filter((name) =>
            name.startsWith("org.mpris.MediaPlayer2."),
          );

          this._hasMprisPlayer = playerNames.length > 0;

          if (playerNames.length === 0) {
            this._hasPlayingPlayer = false;

            this._syncUi();

            return;
          }

          let pending = playerNames.length;

          let hasPlayingPlayer = false;

          for (const busName of playerNames) {
            Gio.DBus.session.call(
              busName,
              "/org/mpris/MediaPlayer2",
              "org.freedesktop.DBus.Properties",
              "Get",
              new GLib.Variant("(ss)", [
                "org.mpris.MediaPlayer2.Player",
                "PlaybackStatus",
              ]),
              null,
              Gio.DBusCallFlags.NONE,
              -1,
              null,
              (c, r) => {
                try {
                  const value = c.call_finish(r);

                  const status = value.deep_unpack()[0].deep_unpack();

                  if (status === "Playing") {
                    hasPlayingPlayer = true;
                  }
                } catch {}

                pending--;

                if (pending === 0) {
                  this._hasPlayingPlayer = hasPlayingPlayer;

                  this._syncUi();
                }
              },
            );
          }
        } catch (error) {
          logError(error);
        }
      },
    );
  }

  // =========================================================
  // Lyrics
  // =========================================================

  _startLyricsProcess() {
    try {
      this._lyricsProcess = new Gio.Subprocess({
        argv: ["sptlrx", "pipe"],
        flags: Gio.SubprocessFlags.STDOUT_PIPE,
      });

      this._lyricsProcess.init(null);

      const stdoutPipe = this._lyricsProcess.get_stdout_pipe();

      this._lyricsStream = new Gio.DataInputStream({
        base_stream: stdoutPipe,
      });

      this._readLyricsLine();
    } catch (error) {
      logError(error);

      this._panelLabel?.set_text("lyrics error");
    }
  }

  _readLyricsLine() {
    if (this._destroyed || !this._lyricsStream) {
      return;
    }

    this._lyricsStream.read_line_async(
      GLib.PRIORITY_DEFAULT,
      null,
      (stream, result) => {
        if (this._destroyed || stream !== this._lyricsStream) {
          return;
        }

        try {
          const [line] = stream.read_line_finish_utf8(result);

          if (line === null) {
            return;
          }

          const lyrics = line.trim();

          this._panelLabel?.set_text(lyrics);

          this._floatingLyricsLabel?.set_text(lyrics);

          if (lyrics.length > 0) {
            this._lastLyricsTimestampUs = GLib.get_monotonic_time();

            this._syncUi();
          }

          this._readLyricsLine();
        } catch (error) {
          logError(error);
        }
      },
    );
  }
}
