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

  async function flush() {
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(cache, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      logger?.warn?.(`设置写入失败：${err?.message || String(err)}`);
    }
  }

  return {
    /** 启动时调用一次，之后 get 就是同步的 */
    load,
    get: (key) => (key in cache ? cache[key] : undefined),
    set: (key, value) => {
      cache[key] = value;
      void flush();
      return true;
    },
    setMany: (patch) => {
      Object.assign(cache, patch);
      void flush();
    },
    all: () => ({ ...cache }),
    /** 落盘一次，测试与关闭前用得上 */
    flush,
  };
}
