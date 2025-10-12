export type InferredType = "string" | "number" | "boolean" | "object" | "array";

export interface TypeInfo {
  type: InferredType | "any";
  properties?: Map<string, TypeInfo>;
}

export interface PropNode {
  children: Map<string, PropNode>;
  inferredType?: InferredType;
}

let typeCache = new Map<string, TypeInfo>();

export function updateTypeCache(map: Map<string, PropNode>): void {
  typeCache.clear();

  for (const [root, node] of map) {
    typeCache.set(root, convertNodeToTypeInfo(node));
  }
}

function convertNodeToTypeInfo(node: PropNode): TypeInfo {
  const info: TypeInfo = {
    type: node.inferredType || "any",
  };

  if (node.children.size > 0) {
    info.properties = new Map();
    for (const [key, childNode] of node.children) {
      info.properties.set(key, convertNodeToTypeInfo(childNode));
    }
  }

  return info;
}

export function getTypeCache(): Map<string, TypeInfo> {
  return typeCache;
}
