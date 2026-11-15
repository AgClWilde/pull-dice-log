"use strict";

// All identities, paths, and messages below are synthetic test fixtures.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const util = require("node:util");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const FIXTURE_SETTINGS = {
  gcloudConfiguration: "fixture-configuration",
  gcloudAccount: "fixture@example.invalid",
  gcloudProject: "fixture-project",
  sshTarget: "fixture-vm",
  zone: "fixture-zone",
  instance1Db: "/srv/fixture/instance-1/data-logs.db",
  instance2Db: "/srv/fixture/instance-2/data-logs.db",
};
const FIXTURE_ITEMS = [
  { nickname: "测试角色甲", im_userid: "QQ:10001", time: 0, message: "第一行\n第二行" },
  { nickname: "测试角色乙", im_userid: "10002", time: 60, message: "正文" },
];

async function loadPlugin({ savedSettings = FIXTURE_SETTINGS, execFileImpl, env = {}, platform = "darwin" } = {}) {
  const notices = [];
  class Plugin {
    async loadData() { return savedSettings; }
    async saveData(settings) { this.saved = settings; }
  }
  class TFolder { constructor(folderPath) { this.path = folderPath; this.name = folderPath.split("/").at(-1); this.children = []; } }
  class Notice { constructor(message) { notices.push(message); } hide() {} }
  class FuzzySuggestModal { setPlaceholder() {} open() {} }
  const execFile = () => { throw new Error("Unexpected process execution"); };
  execFile[util.promisify.custom] = execFileImpl || (async () => { throw new Error("Unexpected process execution"); });
  const context = {
    module: { exports: {} },
    process: { env: { ...process.env, ...env }, platform },
    require(name) {
      if (name === "util") return util;
      if (name === "child_process") return { execFile };
      if (name === "obsidian") return {
        Plugin, Notice, FuzzySuggestModal, TFolder,
        PluginSettingTab: class {}, Setting: class {}, normalizePath: (value) => value,
      };
      throw new Error(`Unexpected require: ${name}`);
    },
  };
  vm.runInNewContext(source, context, { filename: "pull-dice-log/main.js" });
  const plugin = new context.module.exports();
  await plugin.loadSettings();
  const project = new TFolder("fixture-project");
  const files = new Map([[project.path, project]]);
  plugin.app = {
    vault: {
      getAbstractFileByPath(filePath) { return files.get(filePath); },
      async createFolder(folderPath) {
        if (files.has(folderPath)) throw new Error("already exists");
        const folder = new TFolder(folderPath); files.set(folderPath, folder); return folder;
      },
      async create(filePath, content) {
        if (files.has(filePath)) throw new Error("already exists");
        const file = { path: filePath, content }; files.set(filePath, file); return file;
      },
    },
    workspace: { getLeaf() { return { async openFile() {} }; } },
  };
  return { plugin, notices, files, project, TFolder };
}

function shellWithSqliteStub(t, script) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pull-dice-log-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "sqlite3"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return (command) => spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH || ""}` }, timeout: 5000,
  });
}

test("fresh installation has no connection identity and cannot launch a query", async () => {
  let executions = 0;
  const { plugin, notices } = await loadPlugin({ savedSettings: null, execFileImpl: async () => { executions++; } });
  for (const key of Object.keys(FIXTURE_SETTINGS)) assert.equal(plugin.settings[key], "");
  assert.equal(plugin.settings.gcloudPath, "gcloud");
  assert.equal(plugin.instances().length, 0);
  await plugin.runPull();
  assert.equal(executions, 0);
  assert.ok(notices.some((message) => message.includes("请在设置中填写")));
});

test("saved data only supplies known settings of matching types", async () => {
  const { plugin } = await loadPlugin({ savedSettings: { ...FIXTURE_SETTINGS, privateField: "fixture", zone: 4 } });
  assert.equal(plugin.settings.privateField, undefined);
  assert.equal(plugin.settings.zone, "");
  assert.throws(() => plugin.validateConnection(), /请在设置中填写/);
});

test("configured connection overrides ambient gcloud account selection", async () => {
  const { plugin } = await loadPlugin({ env: {
    CLOUDSDK_ACTIVE_CONFIG_NAME: "ambient", CLOUDSDK_CORE_ACCOUNT: "ambient@example.invalid", CLOUDSDK_CORE_PROJECT: "ambient",
  } });
  assert.deepEqual(Array.from(plugin.buildSshArgs("true")), [
    "--configuration=fixture-configuration", "--account=fixture@example.invalid", "--project=fixture-project",
    "--quiet", "compute", "ssh", "fixture-vm", "--zone=fixture-zone", "--tunnel-through-iap", "--command=true",
  ]);
  plugin.settings.tunnelThroughIap = false;
  assert.ok(!plugin.buildSshArgs("true").includes("--tunnel-through-iap"));
});

test("required settings, SSH option injection, and non-absolute databases fail before execution", async () => {
  const { plugin } = await loadPlugin();
  for (const key of ["gcloudPath", "gcloudConfiguration", "gcloudAccount", "gcloudProject", "sshTarget", "zone"]) {
    const previous = plugin.settings[key];
    plugin.settings[key] = " ";
    assert.throws(() => plugin.buildSshArgs("true"), /请在设置中填写/);
    plugin.settings[key] = previous;
  }
  plugin.settings.sshTarget = "--dry-run";
  assert.throws(() => plugin.buildSshArgs("true"), /SSH 目标/);
  plugin.settings.sshTarget = "fixture-user@fixture-vm";
  plugin.settings.instance1Db = "~/data-logs.db";
  assert.throws(() => plugin.listRemoteCmd(), /绝对路径/);
  plugin.settings.instance1Db = ""; plugin.settings.instance2Db = "";
  assert.throws(() => plugin.listRemoteCmd(), /至少配置一个/);
});

test("execution passes an argument array and preserves executable paths with spaces", async () => {
  let captured;
  const { plugin } = await loadPlugin({ execFileImpl: async (...args) => {
    captured = args; return { stdout: "remote output\n" };
  } });
  plugin.settings.gcloudPath = "/fixture directory/gcloud";
  const command = "printf '%s' '$HOME $(exit 93) `exit 94`'";
  assert.equal(await plugin.sshExec(command), "remote output\n");
  assert.equal(captured[0], "/fixture directory/gcloud");
  assert.equal(captured[1].at(-1), `--command=${command}`);
  assert.equal(captured[2].shell, undefined);
  assert.match(captured[2].env.PATH, /^\/opt\/homebrew\/bin:\/usr\/local\/bin:/);
});

test("Windows receives an explicit unsupported-platform message without execution", async () => {
  let calls = 0;
  const { plugin } = await loadPlugin({ platform: "win32", execFileImpl: async () => { calls++; } });
  await assert.rejects(plugin.sshExec("true"), /暂不支持 Windows/);
  assert.equal(calls, 0);
});

test("failed subprocess diagnostics never reveal command, account, or database", async () => {
  const secret = "fixture-command-with-private-token";
  const { plugin, notices } = await loadPlugin({ execFileImpl: async () => { throw new Error(secret); } });
  await assert.rejects(plugin.sshExec(secret), (error) => {
    assert.ok(!error.message.includes(secret)); return true;
  });
  await plugin.runPull();
  assert.ok(!notices.join(" ").includes(secret));
  assert.ok(notices.some((message) => message.includes("云端查询失败")));
});

test("missing gcloud and timeouts produce actionable sanitized notices", async () => {
  for (const [code, expected] of [["ENOENT", /找不到 gcloud/], ["ETIMEDOUT", /超时/]]) {
    const { plugin } = await loadPlugin({ execFileImpl: async () => { throw Object.assign(new Error("private fixture"), { code }); } });
    await assert.rejects(plugin.sshExec("true"), expected);
  }
});

test("a SQLite failure in either instance stops the listing command", async (t) => {
  const { plugin } = await loadPlugin();
  for (const failedInstance of ["instance-1", "instance-2"]) {
    const run = shellWithSqliteStub(t, [
      `case "$3" in */${failedInstance}/*) printf '%s\\n' 'sqlite fixture error' >&2; exit 42;; esac`,
      "printf '%s\\n' '[]'",
    ].join("\n"));
    const result = run(plugin.listRemoteCmd());
    assert.equal(result.status, 42, result.stderr);
    if (failedInstance === "instance-1") assert.ok(!result.stdout.includes("@@INST:instance-2@@"));
  }
});

test("remote shell treats special database paths as one literal argument", async (t) => {
  const { plugin } = await loadPlugin();
  const database = '/tmp/测试 \' "$HOME" $(exit 93) `exit 94` ; fixture/data-logs.db';
  plugin.settings.instance1Db = database; plugin.settings.instance2Db = "";
  const run = shellWithSqliteStub(t, "printf '%s\\n' \"$@\"");
  const listing = run(plugin.listRemoteCmd());
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trimEnd().split("\n"), [
    "@@INST:instance-1@@", "-json", "-readonly", database,
    "SELECT id,name,group_id,created_at,updated_at,size FROM logs ORDER BY updated_at DESC;",
  ]);
  const pull = run(plugin.pullRemoteCmd("instance-1", 7));
  assert.equal(pull.status, 0, pull.stderr);
  assert.deepEqual(pull.stdout.trimEnd().split("\n"), [
    "-json", "-readonly", database,
    "SELECT nickname,im_userid,time,message FROM log_items WHERE log_id=7 AND (removed IS NULL OR removed=0) ORDER BY time ASC, id ASC;",
  ]);
});

test("listing merges by update time without mistaking text inside JSON for markers", async () => {
  const { plugin } = await loadPlugin();
  const first = [{ id: 1, name: "fixture @@INST:instance-2@@", updated_at: 10 }, { id: 2, name: "fixture", updated_at: 30 }];
  const rows = plugin.parseListOutput(`@@INST:instance-1@@\n${JSON.stringify(first)}\n@@INST:instance-2@@\n[{"id":3,"name":"fixture","updated_at":20}]\n`);
  assert.deepEqual(Array.from(rows, (row) => [row.inst, row.id]), [["instance-1", 2], ["instance-2", 3], ["instance-1", 1]]);
  assert.equal(plugin.parseListOutput("@@INST:instance-1@@\n@@INST:instance-2@@\n[]\n").length, 0);
});

test("missing markers, damaged JSON, and malformed list fields fail explicitly", async () => {
  const { plugin } = await loadPlugin();
  for (const output of ["", "[]", "unstructured", "@@INST:instance-1@@\n[]\n"]) {
    assert.throws(() => plugin.parseListOutput(output), /解析失败/);
  }
  for (const body of ["[broken", "{}", "null", "[null]", '[{"id":1}]', '[{"id":1,"name":"fixture","updated_at":"bad"}]']) {
    assert.throws(() => plugin.parseListOutput(`@@INST:instance-1@@\n${body}\n@@INST:instance-2@@\n[]\n`), /解析失败/);
  }
});

test("unavailable instances and non-integer IDs cannot enter SQL", async () => {
  const { plugin } = await loadPlugin();
  assert.throws(() => plugin.pullRemoteCmd("unknown", 1), /未配置/);
  for (const id of [0, -1, 1.5, "1 OR 1=1", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => plugin.pullRemoteCmd("instance-1", id), /无效的 log ID/);
  }
});

test("export retains platform IDs and multiline messages with fixed UTC offset", async () => {
  const { plugin } = await loadPlugin();
  assert.equal(plugin.formatItems(FIXTURE_ITEMS),
    "测试角色甲(QQ:10001) 1970/01/01 08:00:00\n第一行\n第二行\n\n测试角色乙(10002) 1970/01/01 08:01:00\n正文\n");
  assert.match(plugin.formatItems([{ ...FIXTURE_ITEMS[0], nickname: "甲\n乙" }]), /^甲 乙\(QQ:10001\)/);
  for (const im_userid of ["", " ", "x\r\n(y)", "x y", "(x)", NaN]) {
    assert.throws(() => plugin.formatItems([{ ...FIXTURE_ITEMS[0], im_userid }]), /用户 ID/);
  }
  assert.throws(() => plugin.formatItems([null]), /消息字段/);
  plugin.settings.tzOffsetMinutes = -300;
  assert.equal(plugin.fmtTime(0), "1969/12/31 19:00:00");
  plugin.settings.tzOffsetMinutes = 900;
  assert.throws(() => plugin.validateConnection(), /时区偏移/);
});

test("destination cannot escape the selected top-level project", async () => {
  const { plugin, project, TFolder } = await loadPlugin();
  for (const value of ["../outside", "/absolute", "a/../../outside", "a\\outside", "C:/outside", "a//b", "a/./b", "", "a\nb"]) {
    plugin.settings.destSubfolder = value;
    assert.throws(() => plugin.destinationDir(project), /相对路径/);
  }
  plugin.settings.destSubfolder = "exports/session";
  assert.equal(plugin.destinationDir(project), "fixture-project/exports/session");
  assert.throws(() => plugin.destinationDir(new TFolder("../outside")), /顶层项目/);
  assert.throws(() => plugin.destinationDir({ path: "fixture-project" }), /顶层项目/);
});

test("repeated pulls create distinct files and preserve all previous content", async () => {
  const { plugin, files, project } = await loadPlugin();
  plugin.settings.destSubfolder = "exports/session";
  plugin.sshExec = async () => JSON.stringify(FIXTURE_ITEMS);
  const row = { inst: "instance-1", id: 7, name: "CON.txt" };
  for (let i = 0; i < 3; i++) await plugin.doPull(row, project);
  const saved = Array.from(files.values()).filter((file) => "content" in file);
  assert.deepEqual(saved.map((file) => file.path), [
    "fixture-project/exports/session/_CON.txt.txt", "fixture-project/exports/session/_CON.txt_2.txt", "fixture-project/exports/session/_CON.txt_3.txt",
  ]);
  assert.equal(new Set(saved.map((file) => file.content)).size, 1);
});

test("damaged pull JSON fails without writing or reporting an empty log", async () => {
  for (const output of ["fixture-private-content", "{bad", "{}", "null", "[null]"]) {
    const { plugin, files, notices, project } = await loadPlugin();
    plugin.sshExec = async () => output;
    await plugin.doPull({ inst: "instance-1", id: 7, name: "fixture" }, project);
    assert.equal(files.size, 1);
    assert.ok(notices.some((message) => message.startsWith("拉取失败：日志内容解析失败")));
    assert.ok(!notices.join(" ").includes("fixture-private-content"));
    assert.ok(!notices.some((message) => message.includes("没有任何消息")));
  }
});

test("long CJK and emoji log names stay below filesystem byte limits without splitting code points", async () => {
  const { plugin, files, project } = await loadPlugin();
  plugin.sshExec = async () => JSON.stringify(FIXTURE_ITEMS);
  for (const name of ["中".repeat(200), "😀".repeat(200)]) {
    await plugin.doPull({ inst: "instance-1", id: 7, name }, project);
    await plugin.doPull({ inst: "instance-1", id: 7, name }, project);
  }
  const saved = Array.from(files.values()).filter((file) => "content" in file);
  assert.equal(saved.length, 4);
  for (const file of saved) {
    const name = file.path.split("/").at(-1);
    assert.ok(Buffer.byteLength(name, "utf8") <= 206);
    assert.ok(!name.includes("\ufffd"));
    assert.equal(Buffer.from(name, "utf8").toString("utf8"), name);
  }
});

test("empty query results create no files and release the in-progress flag", async () => {
  const { plugin, files, notices, project } = await loadPlugin();
  plugin.sshExec = async () => "";
  await plugin.doPull({ inst: "instance-1", id: 7, name: "fixture" }, project);
  assert.equal(files.size, 1);
  assert.equal(plugin.pulling, false);
  assert.ok(notices.some((message) => message.includes("没有任何消息")));
});

test("local write errors are caught without exposing paths or leaving the plugin busy", async () => {
  const { plugin, notices, project } = await loadPlugin();
  plugin.sshExec = async () => JSON.stringify(FIXTURE_ITEMS);
  plugin.app.vault.create = async () => { throw new Error("fixture-private-path"); };
  await plugin.doPull({ inst: "instance-1", id: 7, name: "fixture" }, project);
  assert.equal(plugin.pulling, false);
  assert.ok(!notices.join(" ").includes("fixture-private-path"));
  assert.ok(notices.some((message) => message.startsWith("拉取失败")));
});
