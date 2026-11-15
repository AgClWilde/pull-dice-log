"use strict";

/* Pull Dice Log 1.1.0
 * Copyright (c) 2026 _yeaz_
 * SPDX-License-Identifier: MIT
 * 使用 gcloud compute ssh 读取 SealDice 的 data-logs.db。
 * 本机需要 Google Cloud CLI；远端需要支持 -json 的 sqlite3 和数据库读取权限。
 * 连接设置由使用者填写，不包含任何预设账号或服务器。
 */

const { Plugin, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFolder, normalizePath } = require("obsidian");
const { execFile } = require("child_process");
const execFileAsync = require("util").promisify(execFile);

const DEFAULT_SETTINGS = Object.freeze({
  gcloudPath: "gcloud",
  gcloudConfiguration: "",
  gcloudAccount: "",
  gcloudProject: "",
  sshTarget: "",
  zone: "",
  tunnelThroughIap: true,
  instance1Db: "",
  instance2Db: "",
  destSubfolder: "pulled-log",
  tzOffsetMinutes: 480,
});

class UserFacingError extends Error {}
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
const userMessage = (error) => error instanceof UserFacingError
  ? error.message : "操作未完成，请检查本地文件权限和插件设置。";

function parseArray(stdout, message) {
  const body = stdout.trim();
  if (!body) return [];
  try {
    const value = JSON.parse(body);
    if (!Array.isArray(value)) throw new Error();
    return value;
  } catch (_) {
    throw new UserFacingError(message);
  }
}

function safeFileName(value) {
  const cleaned = String(value || "log").replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_").trim();
  let name = "", bytes = 0;
  for (const character of cleaned) {
    const codePoint = character.codePointAt(0);
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + size > 200) break;
    name += character; bytes += size;
  }
  name = name.replace(/[. ]+$/, "");
  if (!name || /^\.+$/.test(name)) name = "log";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
  return name;
}

module.exports = class PullDiceLogPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addRibbonIcon("dice", "拉取云端骰子 log", () => this.runPull());
    this.addCommand({ id: "pull-dice-log", name: "从云端拉取跑团 log", callback: () => this.runPull() });
    this.addSettingTab(new PullDiceLogSettingTab(this.app, this));
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (saved && typeof saved[key] === typeof DEFAULT_SETTINGS[key]) this.settings[key] = saved[key];
    }
  }

  async saveSettings() { await this.saveData(this.settings); }

  instances() {
    return [
      { name: "instance-1", db: this.settings.instance1Db.trim() },
      { name: "instance-2", db: this.settings.instance2Db.trim() },
    ].filter((instance) => instance.db);
  }

  validateConnection() {
    const s = this.settings;
    const fields = [s.gcloudPath, s.gcloudConfiguration, s.gcloudAccount, s.gcloudProject, s.sshTarget, s.zone];
    if (!fields.every((value) => typeof value === "string" && value.trim() && !/[\0\r\n]/.test(value))) {
      throw new UserFacingError("请在设置中填写 gcloud 路径、命名配置、Google 账号、项目 ID、SSH 目标和可用区。");
    }
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(s.sshTarget)) {
      throw new UserFacingError("SSH 目标应为实例名或 用户名@实例名。");
    }
    const instances = this.instances();
    if (!instances.length) throw new UserFacingError("请至少配置一个实例的 data-logs.db 路径。");
    if (instances.some(({ db }) => !db.startsWith("/") || /[\0\r\n]/.test(db))) {
      throw new UserFacingError("数据库路径必须是远端绝对路径，且不能包含换行。");
    }
    this.fmtTime(0);
  }

  buildSshArgs(remoteCmd) {
    this.validateConnection();
    const s = this.settings;
    const args = [
      `--configuration=${s.gcloudConfiguration}`, `--account=${s.gcloudAccount}`, `--project=${s.gcloudProject}`,
      "--quiet", "compute", "ssh", s.sshTarget, `--zone=${s.zone}`,
    ];
    if (s.tunnelThroughIap) args.push("--tunnel-through-iap");
    args.push(`--command=${remoteCmd}`);
    return args;
  }

  async sshExec(remoteCmd) {
    const args = this.buildSshArgs(remoteCmd);
    if (process.platform === "win32") {
      throw new UserFacingError("此版本支持 macOS 和 Linux；暂不支持 Windows 的 gcloud.cmd。");
    }
    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` };
    try {
      const { stdout } = await execFileAsync(this.settings.gcloudPath, args, {
        maxBuffer: 128 * 1024 * 1024, timeout: 120000, env,
      });
      return stdout;
    } catch (error) {
      if (error.code === "ENOENT") throw new UserFacingError("找不到 gcloud，请在设置中填写可执行文件绝对路径。");
      if (error.killed || error.code === "ETIMEDOUT") throw new UserFacingError("连接或查询超时，请检查网络与云端连接权限。");
      throw new UserFacingError("云端查询失败。请检查 gcloud 登录、SSH/IAP 权限、远端 sqlite3 与数据库路径；原始命令和账号信息未显示。");
    }
  }

  listRemoteCmd() {
    this.validateConnection();
    return "set -e; " + this.instances().map((instance) =>
      `printf '%s\\n' ${shellQuote(`@@INST:${instance.name}@@`)}; sqlite3 -json -readonly ${shellQuote(instance.db)} ` +
      shellQuote("SELECT id,name,group_id,created_at,updated_at,size FROM logs ORDER BY updated_at DESC;")
    ).join("; ");
  }

  parseListOutput(stdout) {
    const expected = this.instances().map((instance) => instance.name);
    const chunks = stdout.split(/^@@INST:(instance-[12])@@\r?$/m);
    if (chunks[0].trim() || chunks.length !== 1 + expected.length * 2 || !expected.length) {
      throw new UserFacingError("日志列表解析失败：实例标记缺失或输出不完整。");
    }
    const rows = [];
    for (let i = 0; i < expected.length; i++) {
      if (chunks[1 + i * 2] !== expected[i]) throw new UserFacingError("日志列表解析失败：实例顺序不符。");
      const items = parseArray(chunks[2 + i * 2], "日志列表解析失败：需要有效的 JSON 数组。");
      for (const row of items) {
        if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.name !== "string" ||
          !Number.isFinite(row.updated_at)) throw new UserFacingError("日志列表解析失败：条目字段无效。");
        this.fmtTime(row.updated_at);
        rows.push({ ...row, inst: expected[i] });
      }
    }
    return rows.sort((a, b) => b.updated_at - a.updated_at);
  }

  pullRemoteCmd(inst, logId) {
    this.validateConnection();
    const found = this.instances().find((instance) => instance.name === inst);
    if (!found) throw new UserFacingError("未配置所选实例。");
    const id = Number(logId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new UserFacingError("无效的 log ID。");
    return `sqlite3 -json -readonly ${shellQuote(found.db)} ` +
      shellQuote(`SELECT nickname,im_userid,time,message FROM log_items WHERE log_id=${id} ` +
        "AND (removed IS NULL OR removed=0) ORDER BY time ASC, id ASC;");
  }

  fmtTime(unixSec) {
    const offset = this.settings.tzOffsetMinutes;
    if (!Number.isInteger(offset) || offset < -840 || offset > 840) {
      throw new UserFacingError("时区偏移须为 -840 至 840 之间的整数分钟。");
    }
    const d = new Date((Number(unixSec) + offset * 60) * 1000);
    if (!Number.isFinite(d.getTime())) throw new UserFacingError("日志包含无效时间戳。");
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  formatItems(items) {
    return items.map((item) => {
      if (!item || typeof item.nickname !== "string" || typeof item.message !== "string" ||
        !["string", "number"].includes(typeof item.im_userid) || !Number.isFinite(item.time)) {
        throw new UserFacingError("日志内容解析失败：消息字段无效。");
      }
      const nickname = item.nickname.replace(/[\r\n]/g, " ");
      const userId = String(item.im_userid);
      if (!userId || /[\s()]/.test(userId) ||
        (typeof item.im_userid === "number" && !Number.isSafeInteger(item.im_userid))) {
        throw new UserFacingError("日志内容解析失败：用户 ID 不能为空或包含空白、括号。");
      }
      return `${nickname}(${userId}) ${this.fmtTime(item.time)}\n${item.message}\n`;
    }).join("\n");
  }

  destinationDir(projectFolder) {
    const project = projectFolder && projectFolder.path;
    if (!(projectFolder instanceof TFolder) || typeof project !== "string" ||
      !project || project.startsWith(".") || /[\\/\0\r\n:]/.test(project)) {
      throw new UserFacingError("请选择仓库中的顶层项目文件夹。");
    }
    const subfolder = this.settings.destSubfolder.trim();
    const parts = subfolder.split("/");
    if (!subfolder || parts.some((part) => !part || part === "." || part === ".." ||
      /[\\:*?"<>|\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part))) {
      throw new UserFacingError("存放子文件夹必须是项目内的相对路径，不能包含空段、父目录或特殊字符。");
    }
    return normalizePath(`${project}/${subfolder}`);
  }

  async ensureDirectory(dir) {
    const parts = dir.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const current = parts.slice(0, i).join("/");
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing && !(existing instanceof TFolder)) throw new UserFacingError("存放路径被同名文件占用。");
      if (!existing) await this.app.vault.createFolder(current);
    }
  }

  async runPull() {
    const notice = new Notice("正在从云端列出 log…", 0);
    try {
      const rows = this.parseListOutput(await this.sshExec(this.listRemoteCmd()));
      if (!rows.length) { new Notice("已配置的实例中没有找到任何 log。", 6000); return; }
      new LogSuggestModal(this.app, this, rows).open();
    } catch (error) {
      new Notice("列出 log 失败：" + userMessage(error), 8000);
    } finally { notice.hide(); }
  }

  async doPull(row, projectFolder) {
    if (this.pulling) { new Notice("正在拉取另一份 log，请稍候。"); return; }
    this.pulling = true;
    const notice = new Notice("正在拉取 log…", 0);
    try {
      const dir = this.destinationDir(projectFolder);
      const out = await this.sshExec(this.pullRemoteCmd(row.inst, row.id));
      const items = parseArray(out, "日志内容解析失败：需要有效的 JSON 数组。");
      if (!items.length) { new Notice("该 log 没有任何消息。", 6000); return; }
      const text = this.formatItems(items);
      await this.ensureDirectory(dir);
      const name = safeFileName(row.name);
      let filePath = normalizePath(`${dir}/${name}.txt`);
      for (let n = 2; this.app.vault.getAbstractFileByPath(filePath); n++) {
        filePath = normalizePath(`${dir}/${name}_${n}.txt`);
      }
      const file = await this.app.vault.create(filePath, text);
      new Notice(`已保存 ${items.length} 条消息。`, 6000);
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (error) {
      new Notice("拉取失败：" + userMessage(error), 8000);
    } finally { notice.hide(); this.pulling = false; }
  }
};

class LogSuggestModal extends FuzzySuggestModal {
  constructor(app, plugin, rows) {
    super(app); this.plugin = plugin; this.rows = rows;
    this.setPlaceholder("选择要拉取的 log（按最近修改时间排序）");
  }
  getItems() { return this.rows; }
  getItemText(row) {
    const size = row.size != null ? `${row.size}条` : "";
    return `${row.name}  ·  ${this.plugin.fmtTime(row.updated_at)}  ·  ${row.inst}  ·  ${row.group_id || ""}  ${size}`;
  }
  onChooseItem(row) { new ProjectSuggestModal(this.app, this.plugin, row).open(); }
}

class ProjectSuggestModal extends FuzzySuggestModal {
  constructor(app, plugin, row) {
    super(app); this.plugin = plugin; this.row = row;
    this.setPlaceholder("选择目标项目（请先在仓库顶层建立文件夹）");
  }
  getItems() {
    const folders = this.app.vault.getRoot().children.filter((item) => item instanceof TFolder && !item.name.startsWith("."));
    const active = this.app.workspace.getActiveFile();
    if (active && active.path.includes("/")) {
      const top = active.path.split("/")[0];
      folders.sort((a, b) => Number(b.name === top) - Number(a.name === top));
    }
    return folders;
  }
  getItemText(folder) { return folder.path; }
  onChooseItem(folder) { this.plugin.doPull(this.row, folder); }
}

class PullDiceLogSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Pull Dice Log 设置" });
    containerEl.createEl("p", { text: "支持 macOS / Linux 上的 Google Cloud CLI。账号与路径仅保存在当前插件设置中；公开插件目录前请移除 data.json。" });
    const text = (name, desc, key, placeholder = "") => new Setting(containerEl)
      .setName(name).setDesc(desc).addText((field) => field.setPlaceholder(placeholder)
        .setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value.trim(); await this.plugin.saveSettings();
        }));
    text("gcloud 路径", "命令名或可执行文件绝对路径；GUI 找不到命令时使用绝对路径", "gcloudPath", "gcloud");
    text("gcloud 命名配置", "填写本机已建立并登录的命名配置", "gcloudConfiguration", "your-configuration");
    text("Google 账号", "每次连接显式选择此账号", "gcloudAccount", "user@example.invalid");
    text("Google Cloud 项目 ID", "填写实例所属项目", "gcloudProject", "your-project-id");
    text("SSH 目标", "实例名，或 用户名@实例名", "sshTarget", "your-instance");
    text("可用区", "填写实例所在的 Google Cloud 可用区", "zone", "your-zone");
    text("实例 1 数据库", "远端 data-logs.db 绝对路径；可留空", "instance1Db", "/srv/sealdice/instance-1/data/default/data-logs.db");
    text("实例 2 数据库", "远端 data-logs.db 绝对路径；至少配置一个实例", "instance2Db", "/srv/sealdice/instance-2/data/default/data-logs.db");
    text("存放子文件夹", "相对所选项目的路径；同名文件以序号区分，不覆盖", "destSubfolder", "pulled-log");
    new Setting(containerEl).setName("走 IAP 隧道")
      .setDesc("需有 IAP 访问权限；关闭后由 gcloud 直接连接 SSH")
      .addToggle((field) => field.setValue(this.plugin.settings.tunnelThroughIap).onChange(async (value) => {
        this.plugin.settings.tunnelThroughIap = value; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("时区偏移（分钟）").setDesc("固定 UTC 偏移，不自动调整夏令时；北京为 480")
      .addText((field) => field.setValue(String(this.plugin.settings.tzOffsetMinutes)).onChange(async (value) => {
        const offset = Number(value);
        if (value.trim() && Number.isInteger(offset) && offset >= -840 && offset <= 840) {
          this.plugin.settings.tzOffsetMinutes = offset; await this.plugin.saveSettings();
        }
      }));
  }
}
