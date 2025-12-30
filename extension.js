import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

export default class LyricsExtension extends Extension {
  enable() {
    this._destroyed = false;
    this._floatingEnabled = true; // 用户开关

    this._label = new St.Label({
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "panel-status-menu-box",
    });
    this._button = new St.Button({
      child: this._label,
      reactive: true,
      can_focus: true,
      track_hover: true,
    });

    const leftBox =
      Main.panel?.statusArea?.aggregateMenu?.container ?? Main.panel?._leftBox;
    if (leftBox) {
      leftBox.insert_child_at_index(this._button, 2);
    }

    this._menuManager = new PopupMenu.PopupMenuManager(this);
    // 修改menu位置，起点不在中间，在最左边
    this._menu = new PopupMenu.PopupMenu(this._button, 0.0, St.Side.TOP);
    this._menuManager.addMenu(this._menu);
    Main.uiGroup.add_child(this._menu.actor);
    this._menu.actor.hide();
    this._menu._boxPointer.setSourceAlignment(0.0);
    this._menu.actor.set_x_align(Clutter.ActorAlign.START);
    this._floatingToggleItem = new PopupMenu.PopupSwitchMenuItem(
      "显示悬浮歌词",
      this._floatingEnabled,
    );
    this._floatingToggleItem.connect("toggled", (_item, state) => {
      this._floatingEnabled = state;
      this._updateVisibility();
    });
    this._menu.addMenuItem(this._floatingToggleItem);
    this._button.connect("clicked", () => {
      this._menu.toggle();
    });

    this._createFloatingLyrics();

    this._panelSignals = [];
    const panelBox = Main.layoutManager.panelBox;
    this._panelSignals.push(
      panelBox.connect("notify::visible", () => this._updateVisibility()),
      panelBox.connect("notify::height", () => this._updateVisibility()),
      panelBox.connect("notify::opacity", () => this._updateVisibility()),
      panelBox.connect("notify::allocation", () => this._updateVisibility()),
    );

    const overview = Main.overview;
    const controls = overview?._overview?.controls;
    if (controls) {
      this._controlsSignals = controls.connect("notify::progress", () =>
        this._updateVisibility(),
      );
    }

    this._overviewSignals = [];
    this._overviewSignals = [
      overview.connect("showing", () => this._updateVisibility()),
      overview.connect("hiding", () => this._updateVisibility()),
      overview.connect("shown", () => this._updateVisibility()),
      overview.connect("hidden", () => this._updateVisibility()),
    ];

    // Shell 启动完成后再做首次判断

    this._startupTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      500,
      // 500ms 是实践中比较稳的值
      () => {
        this._updateVisibility();
        this._startupTimeoutId = null;
        return GLib.SOURCE_REMOVE;
      },
    );
    this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (this._destroyed) return GLib.SOURCE_REMOVE;
      this._updateVisibility();
      return GLib.SOURCE_REMOVE;
    });

    this._enableMpris();
    this._enableMpris2();
    // 启动时主动查一次
    this._queryPlaybackStatus();
    this._startLyrics();
  }

  disable() {
    this._destroyed = true;
    if (this._panelSignals) {
      const panelBox = Main.layoutManager.panelBox;
      this._panelSignals.forEach((id) => {
        try {
          panelBox.disconnect(id);
        } catch (e) {
          // signal 已不存在，忽略
        }
      });
      this._panelSignals = null;
    }
    if (this._overviewSignals) {
      const overview = Main.overview;
      this._overviewSignals.forEach((id) => {
        try {
          overview.disconnect(id);
        } catch (e) {
          // signal 已不存在，忽略
        }
      });
      this._overviewSignals = null;
    }
    if (this._controlsSignals) {
      const controls = Main.overview._overview.controls;
      try {
        controls.disconnect(this._controlsSignals);
      } catch (e) {
        // signal 已不存在，忽略
      }
      this._controlsSignals = null;
    }
    if (this._startupTimeoutId) {
      GLib.source_remove(this._startupTimeoutId);
      this._startupTimeoutId = null;
    }
    if (this._floatingBox) {
      this._floatingBox.destroy();
      this._floatingBox = null;
      this._floatingLabel = null;
    }
    if (this._idleId) {
      GLib.source_remove(this._idleId);
      this._idleId = null;
    }
    if (this._process) {
      try {
        this._process.force_exit();
      } catch {}
    }
    this._stream = null;
    this._process = null;
    if (this._menu) {
      this._menu.destroy();
      this._menu = null;
    }

    if (this._button) {
      this._button.destroy();
      this._button = null;
    }
    if (this._label) {
      this._label.destroy();
      this._label = null;
    }
    if (this._nameOwnerSubId) {
      Gio.DBus.session.signal_unsubscribe(this._nameOwnerSubId);
      this._nameOwnerSubId = null;
    }
    if (this._mprisSubId) {
      Gio.DBus.session.signal_unsubscribe(this._mprisSubId);
      this._mprisSubId = null;
    }
  }
  _enableMpris() {
    this._isPaused = false;

    this._mprisSubId = Gio.DBus.session.signal_subscribe(
      null, // 任意播放器
      "org.freedesktop.DBus.Properties",
      "PropertiesChanged",
      "/org/mpris/MediaPlayer2",
      null,
      Gio.DBusSignalFlags.NONE,
      (_conn, _sender, _path, _iface, _signal, params) => {
        try {
          const [iface, changed] = params.deep_unpack();

          if (iface !== "org.mpris.MediaPlayer2.Player") return;

          if (!changed.PlaybackStatus) return;

          const status = changed.PlaybackStatus.deep_unpack();
          this._applyPlaybackStatus(status);
        } catch (e) {
          logError(e);
        }
      },
    );
  }
  _enableMpris2() {
    this._hasPlayer = false;
    this._playerNums = 0;

    // 监听 NameOwnerChanged：捕获新播放器启动或退出
    this._nameOwnerSubId = Gio.DBus.session.signal_subscribe(
      "org.freedesktop.DBus",
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      null,
      Gio.DBusSignalFlags.NONE,
      (_conn, _sender, _path, _iface, _signal, params) => {
        const [name, oldOwner, newOwner] = params.deep_unpack();
        if (!name.startsWith("org.mpris.MediaPlayer2.")) return;

        if (newOwner) {
          // 新播放器启动
          this._hasPlayer = true;
          this._playerNums = this._playerNums + 1;
          Gio.DBus.session.call(
            name,
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
                const v = c.call_finish(r);
                const status = v.deep_unpack()[0].deep_unpack();
                log(`_enableMpris2-start-${status}`);

                if (status === "Playing" || status === "Paused") {
                  this._applyPlaybackStatus(status);
                }
              } catch {}
            },
          );
        } else {
          // 播放器退出
          this._playerNums = this._playerNums - 1;
          if (this._playerNums === 0) {
            this._hasPlayer = false;
          }
          this._updateVisibility();
        }
      },
    );
  }

  _queryPlaybackStatus() {
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
      (conn, res) => {
        try {
          const ret = conn.call_finish(res);
          const [names] = ret.deep_unpack();

          const players = names.filter((n) =>
            n.startsWith("org.mpris.MediaPlayer2."),
          );

          for (const busName of players) {
            this._hasPlayer = true;
            this._playerNums = this._playerNums + 1;
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
                  const v = c.call_finish(r);
                  const status = v.deep_unpack()[0].deep_unpack();

                  if (status === "Playing" || status === "Paused") {
                    this._applyPlaybackStatus(status);
                  }
                } catch {}
              },
            );
          }
        } catch {}
      },
    );
  }
  _applyPlaybackStatus(status) {
    const paused = status !== "Playing";
    if (paused !== this._isPaused) {
      this._isPaused = paused;
      this._updateVisibility();
    }
  }

  _startLyrics() {
    try {
      this._process = new Gio.Subprocess({
        argv: ["sptlrx", "pipe"],
        flags: Gio.SubprocessFlags.STDOUT_PIPE,
      });
      this._process.init(null);

      const stdout = this._process.get_stdout_pipe();
      this._stream = new Gio.DataInputStream({
        base_stream: stdout,
      });

      this._readLine();
    } catch (e) {
      this._label.set_text("lyrics error");
    }
  }
  _isTopBarActuallyVisible() {
    const controls = Main.overview?._overview?.controls;
    if (
      Main.overview._shown ||
      Main.overview.animationInProgress ||
      (controls && controls.progress > 0)
    ) {
      return true;
    }
    const panelBox = Main.layoutManager?.panelBox;
    return !!(
      panelBox &&
      panelBox.visible &&
      panelBox.height > 0 &&
      panelBox.opacity > 0
    );
  }
  _clearLyrics() {
    // _floatingLabel中文字透明
    if (!this._floatingLabel || this._floatingLabel.destroyed) return;
    this._floatingLabel.opacity = 0;
    this._floatingBox.style_class =
      "lyrics-floating-box lyrics-floating-box-empty";
  }

  _showLyrics() {
    // 恢复
    this._floatingLabel.opacity = 255;
    this._floatingBox.style_class = "lyrics-floating-box";
  }

  _updateVisibility() {
    if (this._destroyed) return;
    if (!this._floatingBox || !this._button) return;
    if (!this._floatingEnabled) {
      this._floatingBox.hide();
      // panel 上的按钮仍然显示，便于再次开启
      this._button.show();
      return;
    }
    if (!this._hasPlayer || this._isPaused) {
      this._floatingBox.hide();
      this._button.hide();
      this._clearLyrics(); // 新增
      return;
    }
    const topBarVisible = this._isTopBarActuallyVisible();
    if (topBarVisible) {
      this._button.show();
      this._clearLyrics();
      this._floatingBox.hide();
    } else {
      this._button.hide();
      this._showLyrics();
      this._floatingBox.show();
    }
  }
  _createFloatingLyrics() {
    this._floatingLabel = new St.Label({
      text: "",
      style_class: "lyrics-floating-label",
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._floatingBox = new St.BoxLayout({
      style_class: "lyrics-floating-box",
      reactive: false,
      y_align: Clutter.ActorAlign.START,
    });

    this._floatingBox.add_child(this._floatingLabel); // === 关键：对齐约束（水平居中） ===

    this._floatingBox.add_constraint(
      new Clutter.AlignConstraint({
        source: global.stage,
        align_axis: Clutter.AlignAxis.X_AXIS,
        factor: 0.5, // 屏幕中点
      }),
    ); // === 顶部对齐 ===

    this._floatingBox.add_constraint(
      new Clutter.AlignConstraint({
        source: global.stage,
        align_axis: Clutter.AlignAxis.Y_AXIS,
        factor: 0.0, // 顶部
      }),
    );

    Main.layoutManager.addChrome(this._floatingBox, {
      affectsStruts: false,
      trackFullscreen: true,
    });

    this._floatingBox.set_y(40); // 顶部留白
    this._floatingBox.hide();
  }
  _readLine() {
    if (!this._stream || this._destroyed) return;

    this._stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
      if (this._destroyed || stream !== this._stream) return;
      try {
        const [line] = stream.read_line_finish_utf8(res);
        if (line !== null) {
          this._label?.set_text(line);
          this._floatingLabel?.set_text(line);
          this._readLine();
        }
      } catch {
        // subprocess ended
      }
    });
  }
}
