'use strict';

/**
 * redraw 路由分域入口（渐进拆分）。
 * 当前仍复用单体 routes/redraw.js，避免一次性大搬迁破坏主链路；
 * 后续按 projects / assets / generation / release 继续下沉。
 */
module.exports = require('../redraw');