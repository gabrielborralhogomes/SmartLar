const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type StopInput = { pedidoId: string; address: string };
type Coordinates = [number, number];

class RouteRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function geocode(address: string, apiKey: string): Promise<Coordinates> {
  const url = new URL("https://api.openrouteservice.org/geocode/search");
  url.searchParams.set("text", address);
  url.searchParams.set("boundary.country", "BRA");
  url.searchParams.set("focus.point.lat", "-23.5505");
  url.searchParams.set("focus.point.lon", "-46.6333");
  url.searchParams.set("size", "1");

  const response = await fetch(url, { headers: { Authorization: apiKey } });
  if (!response.ok) {
    throw new RouteRequestError(`Falha na busca de endereço no OpenRouteService (HTTP ${response.status}).`, 502);
  }

  const result = await response.json();
  const coordinates = result.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2
    || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) {
    throw new RouteRequestError(`Endereço não localizado: ${address}. Confira o cadastro e tente novamente.`, 422);
  }
  return [coordinates[0], coordinates[1]];
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ORS_API_KEY");
  if (!apiKey) return jsonResponse({ error: "route_service_not_configured" }, 503);

  try {
    let body: { originAddress?: unknown; stops?: unknown };
    try {
      body = await request.json();
    } catch {
      throw new RouteRequestError("O corpo da solicitação precisa ser um JSON válido.", 400);
    }

    const originAddress = typeof body.originAddress === "string" ? body.originAddress.trim() : "";
    const stops = body.stops;
    if (!originAddress || !Array.isArray(stops) || stops.length < 1 || stops.length > 50) {
      throw new RouteRequestError("Informe o endereço da loja e entre 1 e 50 paradas.", 400);
    }

    const parsedStops: StopInput[] = stops.map((stop: unknown) => {
      if (!stop || typeof stop !== "object") {
        throw new RouteRequestError("Uma parada está em formato inválido.", 400);
      }
      const candidate = stop as Record<string, unknown>;
      if (typeof candidate.pedidoId !== "string" || !candidate.pedidoId.trim()
        || typeof candidate.address !== "string" || !candidate.address.trim()) {
        throw new RouteRequestError("Cada parada precisa ter um pedido e um endereço.", 400);
      }
      return { pedidoId: candidate.pedidoId, address: candidate.address.trim() };
    });

    if (new Set(parsedStops.map((stop) => stop.pedidoId)).size !== parsedStops.length) {
      throw new RouteRequestError("A lista contém pedidos duplicados.", 400);
    }

    const start = await geocode(originAddress, apiKey);
    const jobs: { id: number; location: Coordinates }[] = [];
    for (const [index, stop] of parsedStops.entries()) {
      jobs.push({ id: index + 1, location: await geocode(stop.address, apiKey) });
    }

    if (jobs.length === 1) {
      return jsonResponse({ orderedIds: [parsedStops[0].pedidoId], durationSeconds: null, distanceMeters: null });
    }

    const response = await fetch("https://api.openrouteservice.org/optimization", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jobs,
        vehicles: [{ id: 1, profile: "driving-car", start }],
      }),
    });
    if (!response.ok) {
      throw new RouteRequestError(`Falha ao otimizar a rota no OpenRouteService (HTTP ${response.status}).`, 502);
    }

    const result = await response.json();
    const route = result.routes?.[0];
    if (!route || !Array.isArray(route.steps)) {
      throw new RouteRequestError("O serviço de rotas não retornou uma rota válida.", 502);
    }
    if (Array.isArray(result.unassigned) && result.unassigned.length > 0) {
      throw new RouteRequestError("O serviço não conseguiu incluir todas as paradas. Confira os endereços.", 422);
    }

    const orderedIds = route.steps
      .filter((step: { type?: string }) => step.type === "job")
      .map((step: { id?: number }) => parsedStops[Number(step.id) - 1]?.pedidoId)
      .filter((id: string | undefined): id is string => Boolean(id));

    if (orderedIds.length !== parsedStops.length) {
      throw new RouteRequestError("A sequência retornada não contém todas as instalações.", 502);
    }

    return jsonResponse({
      orderedIds,
      durationSeconds: Number.isFinite(route.duration) ? route.duration : null,
      distanceMeters: Number.isFinite(route.distance) ? route.distance : null,
    });
  } catch (error) {
    if (error instanceof RouteRequestError) {
      return jsonResponse({ error: "route_request_failed", message: error.message }, error.status);
    }
    console.error("Route optimization failed:", error);
    return jsonResponse({ error: "route_request_failed", message: "Não foi possível calcular a rota. Tente novamente." }, 500);
  }
});
