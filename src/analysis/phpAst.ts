import {
  Engine,
  Node,
  Call,
  PropertyLookup,
  Identifier,
  Variable,
} from "php-parser";

const php = new Engine({
  parser: { php8: true, suppressErrors: true },
  ast: { withPositions: true },
});

/* ---------- type‑guards ------------------------------------ */

function isPropLookup(n: Node): n is PropertyLookup {
  return n.kind === "propertylookup";
}
function isIdentifier(n: Node): n is Identifier {
  return n.kind === "identifier";
}
function isVariable(n: Node): n is Variable {
  return n.kind === "variable";
}
/** Safe helper: devuelve el nombre de un Identificador o Variable */
function getNodeName(n: Node): string | null {
  if (isIdentifier(n)) {
    return n.name;
  }
  if (isVariable(n)) {
    return n.name as string;
  }
  return null;
}

/* ----------  tu búsqueda de llamadas Prisma ---------------- */

export interface PrismaCall {
  model: string;
  op: string;
  args: Node[];
  loc: Node["loc"];
}

export function findPrismaCalls(code: string): PrismaCall[] {
  const ast = php.parseCode(code, "unknown.php"); // OK
  const results: PrismaCall[] = [];

  traverse(ast, (node) => {
    if (node.kind !== "call") {
      return;
    }

    const call = node as Call;
    if (!isPropLookup(call.what)) {
      return;
    } // $prisma->…

    const chain = call.what; // …->findMany
    const op = getNodeName(chain.offset); // "findMany"
    if (!op) {
      return;
    }

    const modelLookup = chain.what; // …->user
    if (!isPropLookup(modelLookup)) {
      return;
    }

    const model = getNodeName(modelLookup.offset); // "user"
    if (!model) {
      return;
    }

    const base = modelLookup.what; // $prisma
    if (!(isVariable(base) && base.name === "prisma")) {
      return;
    }

    results.push({
      model,
      op,
      args: call.arguments,
      loc: call.loc!,
    });
  });

  return results;
}

/* ----------  DFS util -------------------------------------- */
function traverse(node: Node, visit: (n: Node) => void) {
  visit(node);
  for (const key of Object.keys(node)) {
    const child = (node as any)[key];
    if (!child) {
      continue;
    }
    if (Array.isArray(child)) {
      child.forEach((c) => c && traverse(c, visit));
    } else if (typeof child === "object" && (child as Node).kind) {
      traverse(child as Node, visit);
    }
  }
}
