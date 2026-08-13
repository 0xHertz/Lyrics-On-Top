import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const ALL_LABEL = "所有播放器";

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

    window.add(page);

    this._applying = false;
    this._playerRow.connect("notify::selected", () => this._onPlayerSelected());

    this._loadPlayers();
    this._watchPlayers();
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
