import fs from "node:fs/promises";
import path from "node:path";

/**
 * App 自管的设置存储。
 *
 * 为什么不用宿主的 contributes.settings：那套会把配置项塞进 Hana 的全局设置页，
 * 一个只服务本 App 的 Token 摆在那儿有点喧宾夺主。这里改成 App 自己的一份
 * JSON（dataDir/mineru-settings.json），界面也由 App 自己的面板提供。
 *
 * 文件权限 0o600：Token 是明文存的，至少别让同机其他用户顺手读走。
 */
export function createAppSettings({ dataDir, logger }) {
  const file = path.join(dataDir, "mineru-settings.json");
  let cache = {};
  let ready = false;

  async function load() {
    if (ready) return cache;
    try {
      const text = await fs.readFile(file, "utf-8");
      const parsed = JSON.parse(text);
      cache = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      cache = {};
    }
    ready = true;
    return cache;
  }

  /** 串行写队列：两次并发 flush 不会互相覆盖 */
  let writeChain = Promise.resolve();
  /**
   * 修改队列：把「改内存 → 落盘 → 失败回滚」当成一个整体串行执行。
   * 只串行写盘是不够的：A 写失败回滚成旧值时，B 的写盘已经在排队，
   * 结果 B 拿到成功回执，落盘的却是 A 回滚后的旧值。
   */
  let opChain = Promise.resolve();
  function serialize(fn) {
    const run = opChain.catch(() => {}).then(fn);
    opChain = run.catch(() => {});
    return run;
  }

  /**
   * 真正落盘。成功才算成功；失败必须抛出去，不能吞成一行日志。
   * 调用方要的是"设置保存了没有"，而不是"我尝试过了"。
   */
  function flush() {
    writeChain = writeChain.catch(() => {}).then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const payload = JSON.stringify(cache, null, 2);
      const tmp = `${file}.tmp`;
      // 先删掉可能存在的同名路径（包括符号链接），再用 wx 独占创建。
      // 固定临时名 + 默认覆盖模式，等于让别人预置一个符号链接就能改写到别处去。
      await fs.rm(tmp, { force: true }).catch(() => {});
      await fs.writeFile(tmp, payload, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      await fs.rename(tmp, file);
    });
    return writeChain;
  }

  return {
    /** 启动时调用一次，之后 get 就是同步的 */
    load,
    get: (key) => (key in cache ? cache[key] : undefined),
    /**
     * 写入并等待落盘。
     * 以前是 fire-and-forget 后直接 return true，磁盘写不进去也照样报"已保存"，
     * 重启后开关和 Token 悄悄回到旧值。现在失败会 reject。
     */
    set: (key, value) => serialize(async () => {
      const previous = cache[key];
      cache[key] = value;
      try {
        await flush();
      } catch (err) {
        // 落盘失败就回滚内存，别让这一份内存状态骗人
        if (previous === undefined) delete cache[key];
        else cache[key] = previous;
        logger?.warn?.(`设置写入失败：${err?.message || String(err)}`);
        throw err;
      }
      return true;
    }),
    setMany: (patch) => serialize(async () => {
      const backup = {};
      for (const key of Object.keys(patch)) backup[key] = cache[key];
      Object.assign(cache, patch);
      try {
        await flush();
      } catch (err) {
        for (const key of Object.keys(patch)) {
          if (backup[key] === undefined) delete cache[key];
          else cache[key] = backup[key];
        }
        logger?.warn?.(`设置写入失败：${err?.message || String(err)}`);
        throw err;
      }
      return true;
    }),
    all: () => ({ ...cache }),
    /** 落盘一次，测试与关闭前用得上 */
    flush,
  };
}
