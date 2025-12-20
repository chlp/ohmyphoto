import { route } from './router.js';

export default {
  async fetch(request, env) {
    return route(request, env);
  }
};
