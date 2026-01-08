import { Engine } from "php-parser";

export const phpEngine = new Engine({
  parser: {
    php8: true,
    suppressErrors: true,
    extractDoc: true,
  },
  lexer: {
    comment_tokens: true,
  },
  ast: { withPositions: true },
});
