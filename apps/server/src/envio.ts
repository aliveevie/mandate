/** Optional reads from the hosted Envio GraphQL endpoint. */
export async function fetchAttestations(url: string, agentId: bigint) {
  const query = `query($id: String!) {
    Agent_by_pk(id: $id) { latestScore attestationCount tripCount executionCount totalSpent }
    Attestation(where: { agent_id: { _eq: $id } }, order_by: { windowEnd: desc }, limit: 50) {
      complianceScore tripCount executedCount realisedPnlBps windowStart windowEnd evidenceHash mirrored tx timestamp
    }
  }`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { id: agentId.toString() } }),
  });
  if (!r.ok) throw new Error(`envio ${r.status}`);
  const { data } = (await r.json()) as { data: unknown };
  return data;
}
