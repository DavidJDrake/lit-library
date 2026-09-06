// One JSON line per business event, queryable in CloudWatch Logs Insights:
//   filter event like /^kindle\./ | sort @timestamp desc
// Never log file contents or another user's settings.
export function logEvent(name: string, fields: Record<string, unknown> = {}, now: () => Date = () => new Date()): void {
  console.log(JSON.stringify({ ...fields, event: name, at: now().toISOString() }));
}
