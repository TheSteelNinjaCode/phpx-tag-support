import ts from "typescript";

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

// ✅ NEW: Update type cache from parsed TypeScript types
export function updateTypeCacheFromTS(
  globalStubTypes: Record<string, ts.TypeLiteralNode>
): void {
  for (const [varName, typeLiteral] of Object.entries(globalStubTypes)) {
    const existing = typeCache.get(varName);
    if (existing) {
      // Merge properties from TS into existing
      mergeTypeInfo(existing, typeLiteral);
    } else {
      // Create new entry from TS
      typeCache.set(varName, typeInfoFromTypeLiteral(typeLiteral));
    }
  }
}

// ✅ NEW: Handle simple type declarations (declare var x: string;)
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

function mergeTypeInfo(target: TypeInfo, source: ts.TypeLiteralNode): void {
  if (!target.properties) {
    target.properties = new Map();
  }

  for (const member of source.members) {
    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      const existing = target.properties.get(propName);

      if (member.type && ts.isTypeLiteralNode(member.type)) {
        if (existing) {
          mergeTypeInfo(existing, member.type);
        } else {
          target.properties.set(propName, typeInfoFromTypeLiteral(member.type));
        }
      } else if (member.type && !existing) {
        const typeStr = member.type.getText();
        target.properties.set(propName, {
          type: mapTypeStringToInferred(typeStr),
        });
      }
    }
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
