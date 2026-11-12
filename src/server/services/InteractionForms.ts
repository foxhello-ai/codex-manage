import type { ApprovalQuestion } from "../../shared/models";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hasUnsupportedKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).some(key => !allowed.includes(key));

export function readMcpForm(value: unknown): ApprovalQuestion[] | null {
  const schema = record(value);
  if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return null;
  if (hasUnsupportedKeys(schema, ["$schema", "type", "properties", "required", "title", "description", "additionalProperties"]) || schema.additionalProperties && schema.additionalProperties !== true) return null;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(id => typeof id !== "string"))) return null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const result: ApprovalQuestion[] = [];
  for (const [id, raw] of Object.entries(record(schema.properties))) {
    const field = record(raw);
    const type = field.type;
    if (!["string", "number", "integer", "boolean", "array"].includes(String(type))) return null;
    const metadata = ["type", "title", "description", "default"];
    const constraints = type === "string" ? ["enum", "enumNames", "oneOf", "anyOf", "minLength", "maxLength"]
      : type === "array" ? ["items", "minItems", "maxItems", "uniqueItems"]
      : type === "boolean" ? [] : ["minimum", "maximum"];
    // Unsupported validation (including pattern/format/nested schemas) must never
    // silently turn into a less restrictive form.
    if (hasUnsupportedKeys(field, [...metadata, ...constraints])) return null;
    const choices = type === "array" ? record(field.items) : field;
    if (type === "array" && hasUnsupportedKeys(choices, ["type", "enum", "enumNames", "oneOf", "anyOf", "title", "description"])) return null;
    const alternatives = Array.isArray(choices.oneOf) ? choices.oneOf : Array.isArray(choices.anyOf) ? choices.anyOf : null;
    if (choices.oneOf && choices.anyOf || alternatives?.some(option => hasUnsupportedKeys(record(option), ["const", "title", "description"]))) return null;
    const enums = Array.isArray(choices.enum) ? choices.enum : alternatives?.map(option => record(option).const);
    if (type === "array" && (choices.type !== "string" && !alternatives || !enums)) return null;
    if (enums && (!enums.length || enums.some(item => typeof item !== "string") || new Set(enums).size !== enums.length)) return null;
    for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
      if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isFinite(field[key]) || key.includes("Length") && (!Number.isInteger(field[key]) || Number(field[key]) < 0) || key.includes("Items") && (!Number.isInteger(field[key]) || Number(field[key]) < 0))) return null;
    }
    const defaults = field.default === undefined ? undefined : Array.isArray(field.default) ? field.default.map(String) : [String(field.default)];
    result.push({
      id, header: typeof field.title === "string" ? field.title : id,
      question: typeof field.description === "string" ? field.description : "",
      isOther: false, isSecret: false, required: required.includes(id),
      inputType: type === "array" ? "multiselect" : type as ApprovalQuestion["inputType"],
      options: enums ? enums.map((value, index) => ({ value: String(value), label: String(record(alternatives?.[index]).title ?? (Array.isArray(choices.enumNames) ? choices.enumNames[index] : undefined) ?? value), description: "" })) : null,
      ...(typeof field.minimum === "number" ? { minimum: field.minimum } : {}),
      ...(typeof field.maximum === "number" ? { maximum: field.maximum } : {}),
      ...(typeof field.minLength === "number" ? { minLength: field.minLength } : {}),
      ...(typeof field.maxLength === "number" ? { maxLength: field.maxLength } : {}),
      ...(typeof field.minItems === "number" ? { minItems: field.minItems } : {}),
      ...(typeof field.maxItems === "number" ? { maxItems: field.maxItems } : {}),
      ...(field.uniqueItems === true ? { uniqueItems: true } : {}),
      ...(defaults ? { defaultValue: defaults } : {})
    });
  }
  if (required.some(id => !result.some(question => question.id === id))) return null;
  return result;
}

export function validateAnswers(questions: ApprovalQuestion[], answers: Record<string, string[]>): void {
  for (const question of questions) {
    const values = answers[question.id] ?? [];
    if (!values.length && question.required === false) continue;
    if (question.required !== false && (values.length === 0 || values.every(value => !value.trim()))) throw new Error(`请回答“${question.header}”`);
    if (question.inputType !== "multiselect" && values.length > 1) throw new Error(`“${question.header}”只能提交一个答案`);
    if (question.minItems !== undefined && values.length < question.minItems || question.maxItems !== undefined && values.length > question.maxItems || question.uniqueItems && new Set(values).size !== values.length) throw new Error(`“${question.header}”的选择数量不正确`);
    for (const value of values) {
      if (!value.trim() && question.required === false) continue;
      if (question.options?.length && !question.isOther && !question.options.some(option => (option.value ?? option.label) === value)) throw new Error(`“${question.header}”的选项不正确`);
      if (question.inputType === "boolean" && !["true", "false"].includes(value)) throw new Error(`“${question.header}”请选择是或否`);
      if (question.inputType === "number" || question.inputType === "integer") {
        const number = Number(value);
        if (!value.trim() || !Number.isFinite(number) || question.inputType === "integer" && !Number.isInteger(number)
          || question.minimum !== undefined && number < question.minimum || question.maximum !== undefined && number > question.maximum) throw new Error(`“${question.header}”的数值不正确`);
      }
      const length = [...value].length;
      if (question.minLength !== undefined && length < question.minLength || question.maxLength !== undefined && length > question.maxLength) throw new Error(`“${question.header}”的长度不正确`);
    }
  }
}

export function buildMcpContent(questions: ApprovalQuestion[], answers: Record<string, string[]>): Record<string, unknown> {
  validateAnswers(questions, answers);
  const content: Record<string, unknown> = Object.create(null);
  for (const question of questions) {
    const values = answers[question.id] ?? [];
    if (!values.length || question.required === false && values.length === 1 && !values[0].trim()) continue;
    content[question.id] = question.inputType === "multiselect" ? values
      : question.inputType === "boolean" ? values[0] === "true"
      : question.inputType === "number" || question.inputType === "integer" ? Number(values[0]) : values[0];
  }
  return content;
}
