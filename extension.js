import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Soup from "gi://Soup";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const LRCLIB_GET_URL = "https://lrclib.net/api/get";

// 屏幕位置枚举 → [xFactor, yFactor]（0=起始，0.5=居中，1=结束）
const POSITION_FACTORS = {
  "top-left": [0, 0],
  "top-center": [0.5, 0],
  "top-right": [1, 0],
  "center-left": [0, 0.5],
  center: [0.5, 0.5],
  "center-right": [1, 0.5],
  "bottom-left": [0, 1],
  "bottom-center": [0.5, 1],
  "bottom-right": [1, 1],
};

export default class LyricsExtension extends Extension {
  enable() {
    this._destroyed = false;

    this._settings = this.getSettings();
    this._playerName = this._settings.get_string("player-name");
    this._floatingEnabled = this._settings.get_boolean("show-floating");
    this._ownerToName = new Map();

    // 桌面滚动歌词状态
    this._desktopLines = [];
    this._desktopIndex = -1;
    this._desktopTrackKey = null;
    this._activeBusName = null;
    this._positionMs = 0;
    this._positionTimeoutId = null;
    this._fetchSeq = 0;
    this._lyricSource = this._settings.get_string("lyric-source");
    this._sptlrxLast = "";
    this._lastSptlrxState = null;
    this._session = new Soup.Session();
    this._loadDesktopSettings();

    this._settingsSignals = [
      this._settings.connect("changed::player-name", () => {
        this._playerName = this._settings.get_string("player-name");
        this._resetPlaybackState();
        this._queryPlaybackStatus();
        this._updateVisibility();
      }),
      this._settings.connect("changed::show-floating", () => {
        this._floatingEnabled = this._settings.get_boolean("show-floating");
        if (
          this._floatingToggleItem &&
          this._floatingToggleItem.state !== this._floatingEnabled
        ) {
          this._floatingToggleItem.setToggleState(this._floatingEnabled);
        }
        this._updateVisibility();
      }),
    ];

    for (const key of [
      "show-desktop",
      "desktop-font",
      "desktop-font-size",
      "desktop-color",
      "desktop-opacity",
      "desktop-position",
      "desktop-always-on-top",
      "desktop-align",
      "desktop-lines-before",
      "desktop-lines-after",
      "desktop-offset-x",
      "desktop-offset-y",
    ]) {
      this._settingsSignals.push(
        this._settings.connect(`changed::${key}`, () => {
          this._loadDesktopSettings();
          this._onDesktopSettingChanged(key);
        }),
      );
    }

    this._settingsSignals.push(
      this._settings.connect("changed::lyric-source", () => {
        this._onLyricSourceChanged();
      }),
    );

    this._button = new PanelMenu.Button(0.0, "MyButton", false);

    this._label = new St.Label({
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._button.add_child(this._label);

    Main.panel.addToStatusArea("my-button", this._button);

    // menu 对齐
    this._button.menu._boxPointer.setSourceAlignment(0.0);
    this._button.menu.actor.set_x_align(Clutter.ActorAlign.START);

    this._floatingToggleItem = new PopupMenu.PopupSwitchMenuItem(
      "显示悬浮歌词",
      this._floatingEnabled,
    );
    this._floatingToggleItem.connect("toggled", (_item, state) => {
      this._floatingEnabled = state;
      if (this._settings.get_boolean("show-floating") !== state) {
        this._settings.set_boolean("show-floating", state);
      }
      this._updateVisibility();
    });

    this._button.menu.addMenuItem(this._floatingToggleItem);

    this._desktopToggleItem = new PopupMenu.PopupSwitchMenuItem(
      "显示桌面歌词",
      this._desktopEnabled,
    );
    this._desktopToggleItem.connect("toggled", (_item, state) => {
      this._desktopEnabled = state;
      if (this._settings.get_boolean("show-desktop") !== state) {
        this._settings.set_boolean("show-desktop", state);
      }
      this._onDesktopSettingChanged("show-desktop");
    });

    this._button.menu.addMenuItem(this._desktopToggleItem);

    this._createFloatingLyrics();

    if (this._desktopEnabled) {
      this._createDesktopWindow();
    }

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

    this._overviewSignals = [
      overview.connect("showing", () => this._updateVisibility()),
      overview.connect("hiding", () => this._updateVisibility()),
      overview.connect("shown", () => this._updateVisibility()),
      overview.connect("hidden", () => this._updateVisibility()),
    ];

    this._startupTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      500,
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
    this._destroyDesktopWindow();
    this._stopPositionPolling();
    this._fetchSeq++;
    this._session = null;
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
    if (this._settingsSignals) {
      this._settingsSignals.forEach((id) => {
        try {
          this._settings.disconnect(id);
        } catch (e) {
          // signal 已不存在，忽略
        }
      });
      this._settingsSignals = null;
    }
    this._settings = null;
  }

  // ============ 设置 ============

  _loadDesktopSettings() {
    const s = this._settings;
    this._desktopEnabled = s.get_boolean("show-desktop");
    this._desktopFont = s.get_string("desktop-font");
    this._desktopFontSize = s.get_int("desktop-font-size");
    this._desktopColor = s.get_string("desktop-color");
    this._desktopOpacity = s.get_double("desktop-opacity");
    this._desktopPosition = s.get_string("desktop-position");
    this._alwaysOnTop = s.get_boolean("desktop-always-on-top");
    this._desktopAlign = s.get_string("desktop-align");
    this._linesBefore = s.get_int("desktop-lines-before");
    this._linesAfter = s.get_int("desktop-lines-after");
    this._offsetX = s.get_int("desktop-offset-x");
    this._offsetY = s.get_int("desktop-offset-y");
  }

  _onDesktopSettingChanged(key) {
    if (this._destroyed) return;
    switch (key) {
      case "show-desktop":
        if (this._desktopToggleItem && this._desktopToggleItem.state !== this._desktopEnabled) {
          this._desktopToggleItem.setToggleState(this._desktopEnabled);
        }
        if (this._desktopEnabled) {
          if (!this._desktopBox) this._createDesktopWindow();
          this._updateDesktopVisibility();
        } else {
          this._destroyDesktopWindow();
        }
        break;
      case "desktop-lines-before":
      case "desktop-lines-after":
        this._rebuildDesktopLabels();
        break;
      case "desktop-always-on-top":
        if (this._desktopEnabled) {
          this._destroyDesktopWindow();
          this._createDesktopWindow();
        }
        break;
      case "desktop-position":
      case "desktop-offset-x":
      case "desktop-offset-y":
        this._positionDesktop();
        break;
      case "desktop-font":
      case "desktop-font-size":
      case "desktop-color":
      case "desktop-align":
        this._renderDesktopLyrics();
        break;
      case "desktop-opacity":
        this._applyDesktopStyle();
        break;
    }
  }

  _onLyricSourceChanged() {
    this._lyricSource = this._settings.get_string("lyric-source");
    this._desktopLines = [];
    this._desktopIndex = -1;
    this._desktopTrackKey = null;
    this._sptlrxLast = "";
    this._positionMs = 0;
    this._stopPositionPolling();
    this._renderDesktopLyrics();
    this._updateDesktopVisibility();

    if (this._lyricSource === "lrclib") {
      if (this._activeBusName) this._queryMetadata(this._activeBusName);
      if (!this._isPaused && this._hasPlayer) this._startPositionPolling();
    } else if (this._lastSptlrxState) {
      this._desktopLines = this._lastSptlrxState.lines;
      this._desktopIndex = this._lastSptlrxState.index;
      this._renderDesktopLyrics();
      this._updateDesktopVisibility();
    }
  }

  // ============ MPRIS ============

  _enableMpris() {
    this._isPaused = false;

    this._mprisSubId = Gio.DBus.session.signal_subscribe(
      null, // 任意播放器
      "org.freedesktop.DBus.Properties",
      "PropertiesChanged",
      "/org/mpris/MediaPlayer2",
      null,
      Gio.DBusSignalFlags.NONE,
      (_conn, sender, _path, _iface, _signal, params) => {
        if (!this._isSelectedPlayer(sender)) return;
        try {
          const [iface, changed] = params.deep_unpack();

          if (iface !== "org.mpris.MediaPlayer2.Player") return;

          this._activeBusName = this._ownerToName.get(sender) || sender;

          if (changed.PlaybackStatus) {
            const status = changed.PlaybackStatus.deep_unpack();
            this._applyPlaybackStatus(status);
          }

          if (this._lyricSource === "lrclib") {
            if (changed.Metadata) {
              const meta = changed.Metadata.deep_unpack();
              this._onMetadata(meta);
            }

            if (changed.Position) {
              this._positionMs = changed.Position.deep_unpack() / 1000;
              this._updateDesktopIndex();
            }
          }
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
        if (!name.startsWith(MPRIS_PREFIX)) return;

        if (newOwner) {
          this._ownerToName.set(newOwner, name);
        } else {
          this._ownerToName.delete(oldOwner);
        }

        if (!this._isSelectedPlayer(name)) return;

        if (newOwner) {
          // 新播放器启动
          this._hasPlayer = true;
          this._playerNums = this._playerNums + 1;
          this._activeBusName = name;
          this._queryPlayerState(name);
        } else {
          // 播放器退出
          this._playerNums = this._playerNums - 1;
          if (this._playerNums === 0) {
            this._hasPlayer = false;
            this._activeBusName = null;
            this._stopPositionPolling();
          }
          this._updateVisibility();
        }
      },
    );
  }

  _queryPlayerState(busName) {
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
    this._queryMetadata(busName);
  }

  _queryMetadata(busName) {
    if (this._lyricSource !== "lrclib") return;
    this._getPlayerProperty(busName, "Metadata", (meta) => {
      this._onMetadata(meta);
    });
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

          const players = names.filter(
            (n) => n.startsWith(MPRIS_PREFIX) && this._isSelectedPlayer(n),
          );

          for (const busName of players) {
            this._hasPlayer = true;
            this._playerNums = this._playerNums + 1;
            this._activeBusName = busName;
            this._trackNameOwner(busName);
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
            this._queryMetadata(busName);
          }
        } catch {}
      },
    );
  }

  _getPlayerProperty(busName, prop, cb) {
    if (!busName) return;
    Gio.DBus.session.call(
      busName,
      "/org/mpris/MediaPlayer2",
      "org.freedesktop.DBus.Properties",
      "Get",
      new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", prop]),
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (c, r) => {
        try {
          const v = c.call_finish(r);
          cb(v.deep_unpack()[0].deep_unpack());
        } catch (e) {
          cb(null);
        }
      },
    );
  }

  _applyPlaybackStatus(status) {
    const paused = status !== "Playing";
    if (paused !== this._isPaused) {
      this._isPaused = paused;
      if (paused) {
        this._stopPositionPolling();
      } else {
        this._startPositionPolling();
        this._refreshPosition();
      }
      this._updateVisibility();
    }
  }

  _isSelectedPlayer(busName) {
    if (this._playerName === "") return true;
    const target = MPRIS_PREFIX + this._playerName;
    if (busName === target) return true;
    return this._ownerToName.get(busName) === target;
  }

  _resetPlaybackState() {
    this._hasPlayer = false;
    this._playerNums = 0;
    this._isPaused = false;
    this._activeBusName = null;
    this._stopPositionPolling();
  }

  _trackNameOwner(busName) {
    Gio.DBus.session.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "GetNameOwner",
      new GLib.Variant("(s)", [busName]),
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (c, r) => {
        try {
          const v = c.call_finish(r);
          const owner = v.deep_unpack()[0];
          this._ownerToName.set(owner, busName);
        } catch {}
      },
    );
  }

  // ============ 元数据 + 歌词 ============

  _unpackString(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    try {
      const u = v.deep_unpack();
      return typeof u === "string" ? u : "";
    } catch (e) {
      return "";
    }
  }

  _unpackArtist(v) {
    if (v === null || v === undefined) return "";
    try {
      const u = v.deep_unpack ? v.deep_unpack() : v;
      if (Array.isArray(u)) return u.join(", ");
      return String(u);
    } catch (e) {
      return "";
    }
  }

  _onMetadata(meta) {
    if (this._lyricSource !== "lrclib") return;
    if (!meta) return;
    const title = this._unpackString(meta["xesam:title"]);
    const artist = this._unpackArtist(meta["xesam:artist"]);
    if (!title) return;

    this._positionMs = 0;
    this._desktopIndex = -1;
    this._fetchLyrics(title, artist, album);
  }

  _fetchLyrics(title, artist) {
    const key = `${title}\u0000${artist}`;
    if (this._desktopTrackKey === key) return;
    this._desktopTrackKey = key;

    const seq = ++this._fetchSeq;
    this._desktopLines = [];
    this._desktopIndex = -1;
    this._updateDesktopVisibility();
    this._renderDesktopLyrics();

    const q = `artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    const msg = Soup.Message.new("GET", `${LRCLIB_GET_URL}?${q}`);
    if (!this._session) return;

    this._session.send_and_read_async(
      msg,
      GLib.PRIORITY_DEFAULT,
      null,
      (s, res) => {
        try {
          if (seq !== this._fetchSeq) return; // 已过期
          const bytes = s.send_and_read_finish(res);
          if (msg.get_status() !== 200) return;

          let data = bytes;
          if (data && typeof data.get_data === "function") data = data.get_data();
          else if (data && typeof data.toArray === "function") data = data.toArray();

          const text = new TextDecoder("utf-8").decode(data);
          const json = JSON.parse(text);

          if (json.syncedLyrics) {
            this._desktopLines = this._parseLrc(json.syncedLyrics);
          }
          if (this._desktopLines.length === 0 && json.plainLyrics) {
            this._desktopLines = [{ time: 0, text: json.plainLyrics.trim() }];
          }

          if (this._desktopLines.length > 0) {
            this._refreshPosition();
            this._updateDesktopIndex();
            this._updateDesktopVisibility();
            this._renderDesktopLyrics();
          }
        } catch (e) {
          logError(e);
        }
      },
    );
  }

  _parseLrc(lrc) {
    const lines = [];
    for (const raw of lrc.split("\n")) {
      const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
      const times = [];
      let m;
      while ((m = re.exec(raw)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        let frac = 0;
        if (m[3]) {
          const ms = m[3].padEnd(3, "0").slice(0, 3);
          frac = parseInt(ms, 10);
        }
        times.push(min * 60000 + sec * 1000 + frac);
      }
      const text = raw.replace(/\[[^\]]*\]/g, "").trim();
      if (times.length === 0 || text === "") continue;
      for (const t of times) lines.push({ time: t, text });
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  // ============ 位置轮询 ============

  _refreshPosition() {
    if (this._lyricSource !== "lrclib") return;
    if (!this._activeBusName) return;
    this._getPlayerProperty(this._activeBusName, "Position", (us) => {
      if (typeof us === "number") {
        this._positionMs = us / 1000;
        this._updateDesktopIndex();
      }
    });
  }

  _startPositionPolling() {
    if (this._lyricSource !== "lrclib") return;
    if (this._positionTimeoutId) return;
    this._positionTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      500,
      () => {
        if (this._destroyed) {
          this._positionTimeoutId = null;
          return GLib.SOURCE_REMOVE;
        }
        if (this._isPaused || !this._activeBusName) {
          this._positionTimeoutId = null;
          return GLib.SOURCE_REMOVE;
        }
        this._refreshPosition();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _stopPositionPolling() {
    if (this._positionTimeoutId) {
      GLib.source_remove(this._positionTimeoutId);
      this._positionTimeoutId = null;
    }
  }

  _updateDesktopIndex() {
    if (!this._desktopLines.length) return;
    const pos = this._positionMs;
    let idx = 0;
    for (let i = 0; i < this._desktopLines.length; i++) {
      if (this._desktopLines[i].time <= pos) idx = i;
      else break;
    }
    if (idx !== this._desktopIndex) {
      this._desktopIndex = idx;
      this._renderDesktopLyrics();
    }
  }

  // ============ 悬浮歌词（原有） ============

  _startLyrics() {
    try {
      this._process = new Gio.Subprocess({
        argv: ["sptlrx", "pipe", "--json"],
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
    } else if (!this._hasPlayer || this._isPaused) {
      this._floatingBox.hide();
      this._button.hide();
      this._clearLyrics(); // 新增
    } else {
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
    this._updateDesktopVisibility();
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
          this._handleSptlrxOutput(line);
          this._readLine();
        }
      } catch {
        // subprocess ended
      }
    });
  }

  _handleSptlrxOutput(line) {
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      parsed = null;
    }

    if (parsed && typeof parsed === "object" && "lines" in parsed) {
      const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
      const lines = rawLines.map((l) => ({
        time: typeof l.time === "number" ? l.time : 0,
        text: l.words ?? "",
      }));
      const index = typeof parsed.index === "number" ? parsed.index : -1;
      const current = index >= 0 && index < lines.length ? lines[index].text : "";

      this._lastSptlrxState = { lines, index };
      this._label?.set_text(current);
      this._floatingLabel?.set_text(current);

      if (this._lyricSource === "sptlrx") {
        this._desktopLines = lines;
        this._desktopIndex = index;
        this._renderDesktopLyrics();
        this._updateDesktopVisibility();
      }
    } else {
      this._label?.set_text(line);
      this._floatingLabel?.set_text(line);
      this._onSptlrxLine(line);
    }
  }

  // ============ 桌面滚动歌词（新） ============

  _onSptlrxLine(line) {
    if (this._lyricSource !== "sptlrx") return;
    const text = (line ?? "").trim();
    if (!text || text === this._sptlrxLast) return;
    this._sptlrxLast = text;
    this._desktopLines.push({ time: this._desktopLines.length, text });
    if (this._desktopLines.length > 200) this._desktopLines.shift();
    this._desktopIndex = this._desktopLines.length - 1;
    this._renderDesktopLyrics();
    this._updateDesktopVisibility();
  }

  _createDesktopWindow() {
    if (this._desktopBox) return;

    this._desktopBox = new St.BoxLayout({
      style_class: "lyrics-desktop-box",
      vertical: true,
      reactive: false,
    });
    this._desktopLabels = [];

    this._applyDesktopLayer();
    this._rebuildDesktopLabels();

    this._stageSignals = [
      global.stage.connect("notify::width", () => this._positionDesktop()),
      global.stage.connect("notify::height", () => this._positionDesktop()),
    ];

    this._updateDesktopVisibility();
  }

  _destroyDesktopWindow() {
    if (this._stageSignals) {
      this._stageSignals.forEach((id) => {
        try {
          global.stage.disconnect(id);
        } catch (e) {
          // 忽略
        }
      });
      this._stageSignals = null;
    }
    if (this._desktopBox) {
      this._desktopBox.destroy();
      this._desktopBox = null;
      this._desktopLabels = null;
    }
  }

  _applyDesktopLayer() {
    if (!this._desktopBox) return;
    if (this._alwaysOnTop) {
      Main.layoutManager.addChrome(this._desktopBox, {
        affectsStruts: false,
        affectsInputRegion: false,
      });
    } else {
      const bg = Main.layoutManager._backgroundGroup || global.window_group;
      bg.add_child(this._desktopBox);
    }
  }

  _rebuildDesktopLabels() {
    if (!this._desktopBox) return;
    if (this._desktopLabels) {
      for (const l of this._desktopLabels) l.destroy();
    }
    this._desktopLabels = [];
    const total = this._linesBefore + 1 + this._linesAfter;
    for (let i = 0; i < total; i++) {
      const label = new St.Label({
        text: "",
        style_class: "lyrics-desktop-label",
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        reactive: false,
      });
      this._desktopLabels.push(label);
      this._desktopBox.add_child(label);
    }
    this._applyDesktopStyle();
    this._renderDesktopLyrics();
  }

  _applyDesktopStyle() {
    if (!this._desktopBox) return;
    this._desktopBox.opacity = Math.round(
      Math.max(0, Math.min(1, this._desktopOpacity)) * 255,
    );
    this._positionDesktop();
  }

  _renderDesktopLyrics() {
    if (!this._desktopBox || !this._desktopLabels) return;
    const center = this._linesBefore;
    const alignCss =
      this._desktopAlign === "left" || this._desktopAlign === "right"
        ? this._desktopAlign
        : "center";
    for (let i = 0; i < this._desktopLabels.length; i++) {
      const label = this._desktopLabels[i];
      const lineIdx = this._desktopIndex - center + i;
      const dist = Math.abs(i - center);
      if (lineIdx < 0 || lineIdx >= this._desktopLines.length) {
        label.text = "";
        label.opacity = 0;
        label.remove_style_class_name("lyrics-desktop-current");
      } else {
        label.text = this._desktopLines[lineIdx].text;
        const sizeScale = Math.max(0.55, Math.pow(0.8, dist));
        const size = this._desktopFontSize * sizeScale;
        const gapScale = Math.max(0.3, Math.pow(0.5, dist));
        const gap = this._desktopFontSize * 0.07 * gapScale;
        label.style = `font-family: ${this._desktopFont}; font-size: ${size.toFixed(1)}pt; color: ${this._desktopColor}; text-align: ${alignCss}; margin-top: ${gap.toFixed(1)}px; margin-bottom: ${gap.toFixed(1)}px;`;
        if (dist === 0) {
          label.opacity = 255;
          label.add_style_class_name("lyrics-desktop-current");
        } else {
          label.remove_style_class_name("lyrics-desktop-current");
          label.opacity = Math.round(
            255 * Math.max(0.35, Math.pow(0.7, dist)),
          );
        }
      }
    }
    this._positionDesktop();
  }

  _positionDesktop() {
    if (!this._desktopBox || this._desktopBox.destroyed) return;
    const stage = global.stage;
    const [minW, natW] = this._desktopBox.get_preferred_width(-1);
    const [minH, natH] = this._desktopBox.get_preferred_height(-1);
    const [xf, yf] =
      POSITION_FACTORS[this._desktopPosition] ?? POSITION_FACTORS.center;
    const x = Math.round((stage.width - natW) * xf) + this._offsetX;
    const y = Math.round((stage.height - natH) * yf) + this._offsetY;
    this._desktopBox.set_position(x, y);
  }

  _updateDesktopVisibility() {
    if (!this._desktopBox) return;
    const show =
      this._desktopEnabled &&
      !this._isPaused &&
      this._hasPlayer &&
      this._desktopLines.length > 0;
    if (show) this._desktopBox.show();
    else this._desktopBox.hide();
  }
}
