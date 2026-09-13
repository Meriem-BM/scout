/** Output-rooted inspection. Imported, unreachable messages are not coverage. */
export interface MessageDescriptor {
  name?: string;
  field: Array<{ name?: string; typeName?: string }>;
  nestedType: MessageDescriptor[];
}

export function outputFields(
  files: Array<{ package?: string; messageType: MessageDescriptor[] }>,
  outputType: string,
): string[] {
  const messages = new Map<string, MessageDescriptor>();

  const index = (prefix: string, message: MessageDescriptor) => {
    const name = [prefix, message.name].filter(Boolean).join(".");

    messages.set(name, message);
    message.nestedType.forEach((nested) => index(name, nested));
  };

  files.forEach((file) =>
    file.messageType.forEach((message) => index(file.package ?? "", message)),
  );

  const fields = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string, path: string, depth: number) => {
    const message = messages.get(name);

    if (!message || depth > 12 || visited.has(name)) {
      return;
    }

    visited.add(name);

    for (const field of message.field) {
      if (!field.name) {
        continue;
      }

      const fieldPath = path ? `${path}.${field.name}` : field.name;

      fields.add(fieldPath);

      if (field.typeName) {
        visit(field.typeName.replace(/^\./, ""), fieldPath, depth + 1);
      }
    }

    visited.delete(name);
  };

  visit(outputType.replace(/^proto:/, "").replace(/^\./, ""), "", 0);

  return [...fields];
}

const normalized = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

export function matchOutputFields(required: string[], available: string[]) {
  // Exact normalized names only. "amount" is not proof of "USD amount".
  return required.filter((field) =>
    available.some((path) => {
      const segments = path.split(".");

      return segments.some(
        (_, index) =>
          normalized(segments.slice(index).join(".")) === normalized(field),
      );
    }),
  );
}
