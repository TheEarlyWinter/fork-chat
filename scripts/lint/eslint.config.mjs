// 正确性检查，不管风格。
//
// 目的只有一条：让机器替人挡住一类低级错误，包括未定义变量、重复键、不可达代码、
// 不可靠的 finally、异步执行器里直接丢 async 函数。风格类规则一律不开，避免几千条
// 噪音把真正的错误埋掉。
//
// 这里明确不承诺的事情：抓不到漏掉的 `await`（浮动 Promise 需要带类型信息的
// no-floating-promises），也抓不到并发时序问题。异步链路的正确性仍然靠测试。
//
// 范围只覆盖本仓库自有源码。SDK、第三方图标脚本、压缩后的第三方 bundle 和构建产物
// 都不在检查范围。

const webGlobals = {
  // 平台与网络
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  ReadableStream: 'readonly',
  WritableStream: 'readonly',
  TransformStream: 'readonly',
  DOMException: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  BroadcastChannel: 'readonly',
  MessageChannel: 'readonly',
  MessagePort: 'readonly',
  EventTarget: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FormData: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly',
  btoa: 'readonly',
  atob: 'readonly',
  // 计时器
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  console: 'readonly',
};

const browserGlobals = {
  ...webGlobals,
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  getComputedStyle: 'readonly',
  matchMedia: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  DragEvent: 'readonly',
  PointerEvent: 'readonly',
  DOMParser: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  FileReader: 'readonly',
  Image: 'readonly',
  HTMLElement: 'readonly',
  customElements: 'readonly',
  ClipboardItem: 'readonly',
};

const nodeGlobals = {
  ...webGlobals,
  process: 'readonly',
  Buffer: 'readonly',
  setImmediate: 'readonly',
  globalThis: 'readonly',
};

const correctnessRules = {
  'no-undef': 'error',
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-async-promise-executor': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-obj-calls': 'error',
  'no-sparse-arrays': 'error',
  'no-template-curly-in-string': 'error',
  'no-useless-catch': 'error',
  'no-unused-private-class-members': 'error',
  'valid-typeof': 'error',
  // 未使用的变量和参数用警告：它们值得看一眼，但不该让门禁失败。
  'no-unused-vars': ['warn', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
};

export default [
  {
    ignores: [
      'ui/assets/sdk.js',
      'ui/vendor/**',
      'sdk/**',
      'dist/**',
      'dist-*/**',
      'node_modules/**',
      '.superpowers/**',
      'docs/**',
      'runtime/**',
    ],
  },
  {
    files: ['ui/assets/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: browserGlobals },
    rules: correctnessRules,
  },
  {
    files: ['lib/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'index.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeGlobals },
    rules: correctnessRules,
  },
];
