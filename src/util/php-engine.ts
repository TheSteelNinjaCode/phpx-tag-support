import { Engine } from "php-parser";

export const phpEngine = new Engine({
  parser: { php8: true, suppressErrors: true },
  ast: { withPositions: true },
});
