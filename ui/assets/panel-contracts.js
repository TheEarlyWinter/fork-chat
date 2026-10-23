/**
 * 前端依赖契约与运行时类型断言工具
 *
 * 统一各业务模块工厂的必需/可选依赖校验，杜绝以 `|| []` 隐式掩盖 `getCards` 错接，
 * 保证所有运行时关键依赖与活对象在读取时 fail-fast。
 * 严禁在顶层访问裸 window 或 document。
 */

export function assertFunction(fn, name, context = 'factory') {
  if (typeof fn !== 'function') {
    throw new TypeError(`${context}: missing required function dependency '${name}'`);
  }
  return fn;
}

export function assertFunctions(deps, names, context = 'factory') {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError(`${context}: deps must be an object`);
  }
  for (const name of names) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`${context}: missing required function dependency '${name}'`);
    }
  }
}

export function assertOptionalFunctions(deps, names, context = 'factory') {
  if (!deps || typeof deps !== 'object') return;
  for (const name of names) {
    const val = deps[name];
    if (val !== undefined) {
      if ((name === 'isDisposed' || name === 'getIsDisposed') && typeof val === 'boolean') {
        continue;
      }
      if (typeof val !== 'function') {
        throw new TypeError(`${context}: optional function '${name}' must be a function`);
      }
    }
  }
}

export function assertObject(obj, name, context = 'factory') {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
    throw new TypeError(`${context}: missing required object dependency '${name}'`);
  }
  return obj;
}

export function assertString(str, name, context = 'factory') {
  if (typeof str !== 'string' || !str) {
    throw new TypeError(`${context}: missing required string dependency '${name}'`);
  }
  return str;
}

/**
 * 严格校验从 getCards getter 获取的卡片集合必须是原生 Array。
 * 坚决禁止使用 `getCards() || []` 悄悄掩盖状态源错接或失效。
 */
export function assertCardsArray(cards, context = 'runtime') {
  if (!Array.isArray(cards)) {
    throw new TypeError(`${context}: getCards must return an Array, received ${cards === null ? 'null' : typeof cards}`);
  }
  return cards;
}

/**
 * 校验指定对象具备必要的方法属性
 */
export function assertMethod(target, methodName, context = 'runtime') {
  if (!target || typeof target[methodName] !== 'function') {
    throw new TypeError(`${context}: expected method '${methodName}' on target, got ${typeof target?.[methodName]}`);
  }
  return target[methodName];
}
