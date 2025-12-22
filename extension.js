import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

export default class LyricsExtension extends Extension {
  enable() {
    this._label = new St.Label({
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "panel-status-menu-box",
    });

    // 插入到左侧状态区
    Main.panel._leftBox.insert_child_at_index(this._label, 2);

    this._startLyrics();
  }

  disable() {
    if (this._process) {
      this._process.force_exit();
      this._process = null;
    }

    if (this._label) {
      this._label.destroy();
      this._label = null;
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

  _readLine() {
    this._stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
      try {
        const [line] = stream.read_line_finish_utf8(res);
        if (line !== null) {
          this._label.set_text(line);
          this._readLine();
        }
      } catch (e) {
        // subprocess ended
      }
    });
  }
}
