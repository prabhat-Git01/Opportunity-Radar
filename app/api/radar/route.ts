import { NextRequest } from "next/server";
import { runOpportunityPipeline } from "@/lib/pipeline";
import { PipelineProgressEvent, UserProfileInput } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const lookingFor = body.lookingFor?.trim() || "";
    const profile = body.profile?.trim() || "";
    const selectedCategories = Array.isArray(body.selectedCategories)
      ? body.selectedCategories
      : ["All"];

    if (!lookingFor && !profile) {
      return new Response(
        JSON.stringify({ error: "Please enter what you are looking for or your student profile." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const input: UserProfileInput = {
      lookingFor: lookingFor || "Internships, hackathons and scholarships for students",
      profile: profile || "Indian undergraduate college student",
      selectedCategories,
    };

    // Return Server-Sent Events stream
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        function sendEvent(event: PipelineProgressEvent) {
          try {
            const data = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(data));
          } catch (e) {
            console.error("[SSE Enqueue Error]", e);
          }
        }

        try {
          await runOpportunityPipeline(input, (event) => {
            sendEvent(event);
          });
        } catch (err: any) {
          console.error("[Radar Pipeline Error]", err);
          let friendly = err?.message || "An unexpected error occurred while searching.";
          if (friendly.includes("API key")) {
            friendly = "Your API key looks wrong";
          } else if (friendly.includes("Too many requests") || friendly.includes("429")) {
            friendly = "Too many requests, wait a minute";
          } else if (friendly.includes("free limit") || friendly.includes("402")) {
            friendly = "Daily free limit reached";
          } else if (friendly.includes("reach TinyFish") || friendly.includes("fetch failed")) {
            friendly = "Couldn't reach TinyFish";
          }

          sendEvent({
            stage: "error",
            message: friendly,
            data: { error: friendly },
          });
        } finally {
          try {
            controller.close();
          } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err: any) {
    console.error("[Radar Route Error]", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
