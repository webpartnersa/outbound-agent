import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("❌ Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// ✅ Health check route
fastify.get("/", async (_, reply) => {
  reply.send({ message: "✅ Server is running" });
});

// ✅ Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ✅ Helper function to get signed URL for ElevenLabs
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("❌ Error getting signed URL:", error);
    throw error;
  }
}

// ✅ Route to initiate an outbound call
fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "❌ Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${request.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}&first_message=${encodeURIComponent(first_message)}`,
    });

    console.log(`📞 Call initiated to ${number}, Call SID: ${call.sid}`);

    reply.send({
      success: true,
      message: "📞 Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("❌ Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "❌ Failed to initiate call",
    });
  }
});

// ✅ TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "";
  const first_message = request.query.first_message || "";

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
          </Stream>
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// ✅ WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
    console.info("✅ [Server] Twilio connected to outbound media stream");

    // Variables to track the call
    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null;

    // Handle WebSocket errors
    ws.on("error", console.error);

    // ✅ Set up ElevenLabs connection
    const setupElevenLabs = async () => {
      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          console.log("✅ [ElevenLabs] Connected to Conversational AI");

          // Send initial configuration with prompt and first message
          const initialConfig = {
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              agent: {
                prompt: {
                  prompt: customParameters?.prompt || "You are Gary from the phone store.",
                },
                first_message: customParameters?.first_message || "Hey there! How can I help you today?",
              },
            },
          };

          console.log("✅ [ElevenLabs] Sending initial config:", initialConfig);
          elevenLabsWs.send(JSON.stringify(initialConfig));
        });

        elevenLabsWs.on("message", data => {
          try {
            const message = JSON.parse(data);

            switch (message.type) {
              case "audio":
                if (streamSid) {
                  const audioData = {
                    event: "media",
                    streamSid,
                    media: {
                      payload: message.audio?.chunk || message.audio_event?.audio_base_64,
                    },
                  };
                  ws.send(JSON.stringify(audioData));
                  console.log("🔊 [Twilio] Sending AI-generated speech to call.");
                } else {
                  console.log("⚠️ [ElevenLabs] Received audio but no StreamSid.");
                }
                break;

              case "ping":
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(
                    JSON.stringify({ type: "pong", event_id: message.ping_event.event_id })
                  );
                }
                break;

              case "agent_response":
                console.log(`💬 [Twilio] AI Response: ${message.agent_response_event?.agent_response}`);
                break;

              case "user_transcript":
                console.log(`🗣️ [Twilio] User said: ${message.user_transcription_event?.user_transcript}`);
                break;

              default:
                console.log(`⚠️ [ElevenLabs] Unhandled message type: ${message.type}`);
            }
          } catch (error) {
            console.error("❌ [ElevenLabs] Error processing message:", error);
          }
        });

        elevenLabsWs.on("close", () => console.log("❌ [ElevenLabs] Disconnected"));
      } catch (error) {
        console.error("❌ [ElevenLabs] Setup error:", error);
      }
    };

    // Start the ElevenLabs WebSocket connection
    setupElevenLabs();

    // ✅ Handle messages from Twilio
    ws.on("message", message => {
      try {
        const msg = JSON.parse(message);

        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            customParameters = msg.start.customParameters;
            console.log(`✅ [Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
            break;

          case "media":
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              const audioMessage = { user_audio_chunk: msg.media.payload };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;

          case "stop":
            console.log(`✅ [Twilio] Stream ${streamSid} ended`);
            elevenLabsWs?.close();
            break;
        }
      } catch (error) {
        console.error("❌ [Twilio] Error processing message:", error);
      }
    });
  });
});

// ✅ Start the Fastify server
fastify.listen({ port: PORT, host: "0.0.0.0" }, err => {
  if (err) {
    console.error("❌ Error starting server:", err);
    process.exit(1);
  }
  console.log(`🚀 [Server] Listening on port ${PORT}`);
});
