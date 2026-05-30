/**
 * Pure condition (de)serialization for PermissionEditor.
 *
 * IAM permission conditions are stored as
 * `{ operator: { key: string | string[] } }`. Multi-value operators (e.g.
 * `IpAddress` on `aws:SourceIp`) accept a comma-separated input string. The
 * serializer must NEVER persist empty fragments into the array — a trailing
 * comma like "192.168.0.0/16, " previously produced `['192.168.0.0/16', '']`,
 * leaking a bogus empty CIDR into config. These helpers filter empties and
 * coalesce a single survivor to a scalar, mirroring conditionPrefixRows.ts's
 * serializeRows + rowsToPermissions cleanup. No React/antd imports — pure and
 * unit-testable.
 */

type Conditions = Record<string, Record<string, string | string[]>>;

/** Extract a simple condition value for UI display. */
export function getConditionValue(
  conditions: Conditions | undefined,
  operator: string,
  key: string,
): string {
  if (!conditions) return '';
  const opBlock = conditions[operator];
  if (!opBlock) return '';
  const val = opBlock[key];
  if (Array.isArray(val)) return val.join(', ');
  return val || '';
}

/** Remove operator/key from the conditions map, pruning empty operator blocks. */
function removeConditionKey(conditions: Conditions, operator: string, key: string): Conditions {
  const result = { ...conditions };
  if (result[operator]) {
    const { [key]: _removed, ...rest } = result[operator];
    if (Object.keys(rest).length === 0) {
      delete result[operator];
    } else {
      result[operator] = rest;
    }
  }
  return result;
}

/** Set a condition value, creating operator/key structure as needed. */
export function setConditionValue(
  conditions: Conditions | undefined,
  operator: string,
  key: string,
  value: string,
): Conditions {
  const result = conditions ? { ...conditions } : {};
  if (!value.trim()) {
    return removeConditionKey(result, operator, key);
  }
  // Drop empty fragments so a trailing comma can never persist '' into the
  // array. A single survivor coalesces to a scalar string for shape-consistency
  // with the single-value path.
  const parts = value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return removeConditionKey(result, operator, key);
  }
  const parsedValue: string | string[] = parts.length === 1 ? parts[0] : parts;
  result[operator] = { ...(result[operator] || {}), [key]: parsedValue };
  return result;
}

/** Check if a rule has any conditions set. */
export function hasConditions(conditions?: Conditions): boolean {
  if (!conditions) return false;
  return Object.values(conditions).some(kv => Object.values(kv).some(v =>
    typeof v === 'string' ? v.trim() !== '' : v.length > 0
  ));
}
