import ts from "typescript";

export type InferredType = "string" | "number" | "boolean" | "object" | "array";

export interface TypeInfo {
  type: InferredType | "any";
  properties?: Map<string, TypeInfo>;
  element?: TypeInfo;
}

export interface PropNode {
  children: Map<string, PropNode>;
  inferredType?: InferredType;
}

let typeCache = new Map<string, TypeInfo>();

function typeInfoFromTsTypeNode(node: ts.TypeNode): TypeInfo {
  if (ts.isTypeLiteralNode(node)) {
    return typeInfoFromTypeLiteral(node);
  }
  if (ts.isArrayTypeNode(node)) {
    const el = typeInfoFromTsTypeNode(node.elementType);
    return { type: "array", element: el };
  }
  if (
    ts.isTypeReferenceNode(node) &&
    node.typeName.getText() === "Array" &&
    node.typeArguments?.length === 1
  ) {
    const el = typeInfoFromTsTypeNode(node.typeArguments[0]);
    return { type: "array", element: el };
  }
  const t = node.getText().trim();
  return { type: mapTypeStringToInferred(t) };
}

export function updateTypeCache(map: Map<string, PropNode>): void {
  typeCache.clear();

  for (const [root, node] of map) {
    typeCache.set(root, convertNodeToTypeInfo(node));
  }
}

export function updateTypeCacheFromTS(
  globalStubTypes: Record<string, ts.TypeLiteralNode | ts.TypeNode>
) {
  for (const [varName, typeNode] of Object.entries(globalStubTypes as any)) {
    const next = typeInfoFromTsTypeNode(typeNode as ts.TypeNode);
    const existing = typeCache.get(varName);
    typeCache.set(varName, existing ? { ...existing, ...next } : next);
  }
}

export function updateTypeCacheFromSimpleTypes(
  declarations: Map<string, string>
): void {
  for (const [varName, typeStr] of declarations) {
    const inferredType = mapTypeStringToInferred(typeStr);
    const existing = typeCache.get(varName);

    if (existing && existing.type === "any") {
      existing.type = inferredType;
    } else if (!existing) {
      typeCache.set(varName, { type: inferredType });
    }
  }
}

function mapTypeStringToInferred(typeStr: string): InferredType | "any" {
  switch (typeStr.trim()) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      if (typeStr.includes("{")) {
        return "object";
      }
      if (typeStr.includes("[")) {
        return "array";
      }
      return "any";
  }
}

function typeInfoFromTypeLiteral(node: ts.TypeLiteralNode): TypeInfo {
  const properties = new Map<string, TypeInfo>();

  for (const member of node.members) {
    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      const propType = member.type;

      if (propType && ts.isTypeLiteralNode(propType)) {
        properties.set(propName, typeInfoFromTypeLiteral(propType));
      } else if (propType) {
        const typeStr = propType.getText();
        properties.set(propName, {
          type: mapTypeStringToInferred(typeStr),
        });
      }
    }
  }

  return {
    type: "object",
    properties,
  };
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
