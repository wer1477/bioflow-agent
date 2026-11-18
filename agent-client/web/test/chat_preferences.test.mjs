import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLLAPSE_KEY, DEFAULT_COLLAPSE_TIMING, parseCollapseTiming, readCollapseTiming, rememberCollapseTiming,
} from '../src/app/chat_preferences.js';

/** 用一次性假 storage 替换全局 localStorage；返回恢复函数。 */
function withStorage(storage) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  };
}

test('parseCollapseTiming 收窄成两档，非法值回默认', () => {
  assert.equal(parseCollapseTiming('completion'), 'completion');
  assert.equal(parseCollapseTiming('nextInput'), 'nextInput');
  // 没存过 / 存了脏值都不能把用户卡在没有展示策略的状态。
  assert.equal(parseCollapseTiming(null), DEFAULT_COLLAPSE_TIMING);
  assert.equal(parseCollapseTiming(''), DEFAULT_COLLAPSE_TIMING);
  assert.equal(parseCollapseTiming('junk'), DEFAULT_COLLAPSE_TIMING);
  assert.equal(parseCollapseTiming(undefined), DEFAULT_COLLAPSE_TIMING);
  assert.equal(DEFAULT_COLLAPSE_TIMING, 'completion');
});

test('readCollapseTiming 读回存储值，缺省回默认', () => {
  const store = new Map();
  const restore = withStorage({ getItem: (key) => (store.has(key) ? store.get(key) : null) });
  try {
    assert.equal(readCollapseTiming(), 'completion');
    store.set(COLLAPSE_KEY, 'nextInput');
    assert.equal(readCollapseTiming(), 'nextInput');
    store.set(COLLAPSE_KEY, 'junk');
    assert.equal(readCollapseTiming(), 'completion');
  } finally {
    restore();
  }
});

test('rememberCollapseTiming 存收窄后的值', () => {
  const store = new Map();
  const restore = withStorage({
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); },
  });
  try {
    rememberCollapseTiming('nextInput');
    assert.equal(store.get(COLLAPSE_KEY), 'nextInput');
    // 脏值落盘前先收窄，避免下次读回时再判断一次。
    rememberCollapseTiming('junk');
    assert.equal(store.get(COLLAPSE_KEY), 'completion');
  } finally {
    restore();
  }
});

test('storage 不可用或抛错时读写都不抛', () => {
  const restore = withStorage({
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  });
  try {
    assert.equal(readCollapseTiming(), 'completion');
    assert.doesNotThrow(() => rememberCollapseTiming('nextInput'));
  } finally {
    restore();
  }

  const restoreMissing = withStorage(undefined);
  try {
    // 隐私模式下 localStorage 甚至可能不存在：引用它抛的 ReferenceError 也要吞掉。
    assert.equal(readCollapseTiming(), 'completion');
    assert.doesNotThrow(() => rememberCollapseTiming('nextInput'));
  } finally {
    restoreMissing();
  }
});
