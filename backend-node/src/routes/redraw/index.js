'use strict';

/**
 * redraw 路由分域入口（渐进拆分）。
 * - catalog：风格预设 / 语区（已下沉至 redraw/catalog.js）
 * - 其余仍复用单体 routes/redraw.js，避免一次性大搬迁破坏主链路
 */
module.exports = require('../redraw');
