import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";
import Gdk from "gi://Gdk";
import Pango from "gi://Pango";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const ALL_LABEL = "所有播放器";

const POSITIONS = [
  ["top-left", "左上"],
  ["top-center", "顶部居中"],
  ["top-right", "右上"],
  ["center-left", "左侧居中"],
  ["center", "屏幕中央"],
  ["center-right", "右侧居中"],
  ["bottom-left", "左下"],
  ["bottom-center", "底部居中"],
  ["bottom-right", "右下"],
];

const ALIGNS = [
  ["left", "左对齐"],
  ["center", "居中"],
  ["right", "右对齐"],
];

const SOURCES = [
  ["sptlrx", "sptlrx"],
  ["lrclib", "在线搜索 (lrclib)"],
];

export default class LyricsPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage();

    const playerGroup = new Adw.PreferencesGroup({
      title: "播放器",
      description:
        "仅当选中播放器正在播放时显示歌词；选择「所有播放器」则对任意播放器生效。",
    });

    this._playerModel = Gtk.StringList.new([ALL_LABEL]);
    this._playerRow = new Adw.ComboRow({
      title: "监听播放器",
      subtitle: "系统内检测到的 MPRIS 播放器",
      model: this._playerModel,
    });
    playerGroup.add(this._playerRow);

    page.add(playerGroup);

    const floatingGroup = new Adw.PreferencesGroup({ title: "悬浮歌词" });
    const floatingRow = new Adw.SwitchRow({
      title: "显示悬浮歌词",
      subtitle: "顶栏隐藏时显示悬浮歌词",
    });
    settings.bind(
      "show-floating",
      floatingRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    floatingGroup.add(floatingRow);
    page.add(floatingGroup);

    const desktopGroup = new Adw.PreferencesGroup({
      title: "桌面滚动歌词",
      description: "在桌面顶层显示类似 Apple Music 的滚动歌词窗口。",
    });

    const desktopRow = new Adw.SwitchRow({
      title: "显示桌面歌词",
      subtitle: "播放时在桌面顶层显示滚动歌词",
    });
    settings.bind(
      "show-desktop",
      desktopRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    desktopGroup.add(desktopRow);

    this._sourceRow = new Adw.ComboRow({
      title: "歌词来源",
      subtitle: "sptlrx：完整歌词时间轴（需新版 sptlrx，支持 pipe --json）；在线搜索：lrclib 完整时间轴",
      model: Gtk.StringList.new(SOURCES.map((s) => s[1])),
    });
    this._initComboIndex(this._sourceRow, SOURCES, settings.get_string("lyric-source"));
    desktopGroup.add(this._sourceRow);

    this._fontSyncing = false;
    this._fontDialog = new Gtk.FontDialog();
    this._fontButton = new Gtk.FontDialogButton();
    this._fontButton.set_dialog(this._fontDialog);
    this._applyFontButton(settings);
    const fontRow = new Adw.ActionRow({ title: "字体" });
    fontRow.add_suffix(this._fontButton);
    fontRow.set_activatable_widget(this._fontButton);
    desktopGroup.add(fontRow);

    this._fontSizeRow = new Adw.SpinRow({
      title: "字号",
      subtitle: "单位 pt",
      adjustment: new Gtk.Adjustment({
        lower: 6,
        upper: 96,
        step_increment: 1,
      }),
    });
    this._fontSizeRow.set_value(settings.get_int("desktop-font-size"));
    desktopGroup.add(this._fontSizeRow);

    this._colorDialog = new Gtk.ColorDialog();
    this._colorButton = new Gtk.ColorDialogButton();
    this._colorButton.set_dialog(this._colorDialog);
    this._applyColorButton(settings);
    const colorRow = new Adw.ActionRow({ title: "颜色" });
    colorRow.add_suffix(this._colorButton);
    colorRow.set_activatable_widget(this._colorButton);
    desktopGroup.add(colorRow);

    const opacityRow = new Adw.SpinRow({
      title: "透明度",
      subtitle: "0.0 - 1.0，越小越透明",
      adjustment: new Gtk.Adjustment({
        lower: 0.0,
        upper: 1.0,
        step_increment: 0.05,
      }),
      digits: 2,
    });
    opacityRow.set_value(settings.get_double("desktop-opacity"));
    desktopGroup.add(opacityRow);

    this._positionRow = new Adw.ComboRow({
      title: "屏幕位置",
      subtitle: "歌词窗口在屏幕上的位置",
      model: Gtk.StringList.new(POSITIONS.map((p) => p[1])),
    });
    this._initComboIndex(this._positionRow, POSITIONS, settings.get_string("desktop-position"));
    desktopGroup.add(this._positionRow);

    const onTopRow = new Adw.SwitchRow({
      title: "置顶",
      subtitle: "始终显示在所有窗口之上",
    });
    settings.bind(
      "desktop-always-on-top",
      onTopRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    desktopGroup.add(onTopRow);

    this._alignRow = new Adw.ComboRow({
      title: "对齐方式",
      subtitle: "歌词文本的对齐方式",
      model: Gtk.StringList.new(ALIGNS.map((a) => a[1])),
    });
    this._initComboIndex(this._alignRow, ALIGNS, settings.get_string("desktop-align"));
    desktopGroup.add(this._alignRow);

    const linesBeforeRow = new Adw.SpinRow({
      title: "当前歌词前几行",
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 20,
        step_increment: 1,
      }),
    });
    linesBeforeRow.set_value(settings.get_int("desktop-lines-before"));
    desktopGroup.add(linesBeforeRow);

    const linesAfterRow = new Adw.SpinRow({
      title: "当前歌词后几行",
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 20,
        step_increment: 1,
      }),
    });
    linesAfterRow.set_value(settings.get_int("desktop-lines-after"));
    desktopGroup.add(linesAfterRow);

    const offsetXRow = new Adw.SpinRow({
      title: "水平偏移",
      subtitle: "单位像素，正值向右",
      adjustment: new Gtk.Adjustment({
        lower: -10000,
        upper: 10000,
        step_increment: 10,
      }),
    });
    offsetXRow.set_value(settings.get_int("desktop-offset-x"));
    desktopGroup.add(offsetXRow);

    const offsetYRow = new Adw.SpinRow({
      title: "垂直偏移",
      subtitle: "单位像素，正值向下",
      adjustment: new Gtk.Adjustment({
        lower: -10000,
        upper: 10000,
        step_increment: 10,
      }),
    });
    offsetYRow.set_value(settings.get_int("desktop-offset-y"));
    desktopGroup.add(offsetYRow);

    page.add(desktopGroup);

    window.add(page);

    this._applying = false;
    this._playerRow.connect("notify::selected", () => this._onPlayerSelected());

    this._connectDesktopSignals(settings, {
      sourceRow: this._sourceRow,
      fontSizeRow: this._fontSizeRow,
      opacityRow,
      positionRow: this._positionRow,
      alignRow: this._alignRow,
      linesBeforeRow,
      linesAfterRow,
      offsetXRow,
      offsetYRow,
    });

    this._loadPlayers();
    this._watchPlayers();
  }

  _initComboIndex(combo, list, value) {
    const idx = list.findIndex(([v]) => v === value);
    combo.set_selected(idx >= 0 ? idx : 0);
  }

  _applyFontButton(settings) {
    const desc = Pango.FontDescription.new();
    desc.set_family(settings.get_string("desktop-font"));
    desc.set_size(settings.get_int("desktop-font-size") * Pango.SCALE);
    this._fontButton.set_font_desc(desc);
  }

  _applyColorButton(settings) {
    const rgba = new Gdk.RGBA();
    rgba.parse(settings.get_string("desktop-color") || "#ffffff");
    this._colorButton.set_rgba(rgba);
  }

  _rgbaToHex(c) {
    const h = (v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, "0");
    return `#${h(c.red)}${h(c.green)}${h(c.blue)}`;
  }

  _connectDesktopSignals(settings, rows) {
    rows.sourceRow.connect("notify::selected", () => {
      const idx = rows.sourceRow.get_selected();
      if (idx >= 0 && idx < SOURCES.length) {
        settings.set_string("lyric-source", SOURCES[idx][0]);
      }
    });

    this._fontButton.connect("notify::font-desc", () => {
      if (this._fontSyncing) return;
      const desc = this._fontButton.get_font_desc();
      if (!desc) return;
      this._fontSyncing = true;
      const family = desc.get_family();
      const sizePt = Math.round(desc.get_size() / Pango.SCALE);
      if (family) settings.set_string("desktop-font", family);
      if (sizePt > 0) {
        settings.set_int("desktop-font-size", sizePt);
        rows.fontSizeRow.set_value(sizePt);
      }
      this._fontSyncing = false;
    });

    rows.fontSizeRow.connect("notify::value", () => {
      if (this._fontSyncing) return;
      const v = rows.fontSizeRow.get_value();
      if (v === undefined || v === null) return;
      this._fontSyncing = true;
      settings.set_int("desktop-font-size", Math.round(v));
      const desc = this._fontButton.get_font_desc();
      if (desc) {
        desc.set_size(Math.round(v) * Pango.SCALE);
        this._fontButton.set_font_desc(desc);
      }
      this._fontSyncing = false;
    });

    this._colorButton.connect("notify::rgba", () => {
      const c = this._colorButton.get_rgba();
      if (!c) return;
      settings.set_string("desktop-color", this._rgbaToHex(c));
    });

    rows.opacityRow.connect("notify::value", () => {
      const v = rows.opacityRow.get_value();
      if (v === undefined || v === null) return;
      settings.set_double("desktop-opacity", v);
    });

    rows.positionRow.connect("notify::selected", () => {
      const idx = rows.positionRow.get_selected();
      if (idx >= 0 && idx < POSITIONS.length) {
        settings.set_string("desktop-position", POSITIONS[idx][0]);
      }
    });

    rows.alignRow.connect("notify::selected", () => {
      const idx = rows.alignRow.get_selected();
      if (idx >= 0 && idx < ALIGNS.length) {
        settings.set_string("desktop-align", ALIGNS[idx][0]);
      }
    });

    const bindInt = (key, row) => {
      row.connect("notify::value", () => {
        const v = row.get_value();
        if (v === undefined || v === null) return;
        settings.set_int(key, Math.round(v));
      });
    };

    bindInt("desktop-lines-before", rows.linesBeforeRow);
    bindInt("desktop-lines-after", rows.linesAfterRow);
    bindInt("desktop-offset-x", rows.offsetXRow);
    bindInt("desktop-offset-y", rows.offsetYRow);
  }

  _onPlayerSelected() {
    if (this._applying) return;
    const index = this._playerRow.get_selected();
    this.getSettings().set_string(
      "player-name",
      index === 0 ? "" : this._playerModel.get_string(index),
    );
  }

  _loadPlayers() {
    Gio.DBus.session.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListNames",
      null,
      new GLib.VariantType("(as)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (conn, res) => {
        try {
          const [names] = conn.call_finish(res).deep_unpack();
          const current = this.getSettings().get_string("player-name");
          const players = names
            .filter((n) => n.startsWith(MPRIS_PREFIX))
            .map((n) => n.substring(MPRIS_PREFIX.length))
            .filter((p) => p)
            .sort();
          if (current !== "" && !players.includes(current)) {
            players.push(current);
            players.sort();
          }
          this._applying = true;
          this._playerModel = Gtk.StringList.new([ALL_LABEL, ...players]);
          this._playerRow.set_model(this._playerModel);
          this._playerRow.set_selected(
            current === "" ? 0 : players.indexOf(current) + 1,
          );
          this._applying = false;
        } catch (e) {
          logError(e);
        }
      },
    );
  }

  _watchPlayers() {
    if (this._nameOwnerSubId) return;
    this._nameOwnerSubId = Gio.DBus.session.signal_subscribe(
      "org.freedesktop.DBus",
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      null,
      Gio.DBusSignalFlags.NONE,
      (_conn, _sender, _path, _iface, _signal, params) => {
        const [name] = params.deep_unpack();
        if (!name.startsWith(MPRIS_PREFIX)) return;
        this._loadPlayers();
      },
    );
  }

  dispose() {
    if (this._nameOwnerSubId) {
      Gio.DBus.session.signal_unsubscribe(this._nameOwnerSubId);
      this._nameOwnerSubId = null;
    }
    super.dispose();
  }
}
