import { serve } from "https://deno.land/std@0.220.1/http/server.ts";
import { DOMParser, Element } from "https://deno.land/x/deno_dom@v0.1.43/deno-dom-wasm.ts";

interface MCPMessage {
  type: string;
  payload: unknown;
}

interface ScrapeRequest {
  url: string;
  selector?: string;
}

// Helper function to safely encode Unicode strings to base64
function encodeUnicode(str: string): string {
  // First encode the string to UTF-8 bytes
  const bytes = new TextEncoder().encode(str);
  // Convert bytes to base64
  return btoa(
    Array.from(bytes)
      .map(byte => String.fromCharCode(byte))
      .join('')
  );
}

// Helper function to safely decode base64 to Unicode string
function decodeUnicode(str: string): string {
  // First decode base64 to bytes
  const binaryStr = atob(str);
  const bytes = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
  // Convert bytes back to string
  return new TextDecoder().decode(bytes);
}

class WebScraper {
  private userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/122.0.0.0 Safari/537.36"
  ];

  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  async scrape(url: string, selector?: string): Promise<string> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": this.getRandomUserAgent(),
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      
      if (!doc) {
        throw new Error("Failed to parse HTML");
      }

      let content: string;
      if (selector) {
        const elements = doc.querySelectorAll(selector);
        content = Array.from(elements).map((el: Element) => el.textContent || "").join("\n");
      } else {
        // Default content extraction strategy
        const articleContent = doc.querySelector("article");
        if (articleContent) {
          content = articleContent.textContent || "";
        } else {
          // Remove script, style, and other non-content elements
          doc.querySelectorAll("script, style, nav, header, footer").forEach((el: Element) => el.remove());
          content = doc.querySelector("body")?.textContent || "";
        }
      }

      // Clean up the content
      return this.cleanText(content);
    } catch (error) {
      throw new Error(`Failed to scrape ${url}: ${error.message}`);
    }
  }

  private cleanText(text: string): string {
    return text
      .replace(/\s+/g, " ")
      .replace(/\n+/g, "\n")
      .trim();
  }

  summarize(text: string, maxLength = 500): string {
    // Simple extractive summarization
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    if (sentences.length === 0) return text;

    // Score sentences based on position and length
    const scoredSentences = sentences.map((sentence, index) => ({
      text: sentence.trim(),
      score: this.scoreSentence(sentence, index, sentences.length),
    }));

    // Sort by score and take top sentences until we reach maxLength
    scoredSentences.sort((a, b) => b.score - a.score);
    
    let summary = "";
    let i = 0;
    
    while (i < scoredSentences.length && summary.length < maxLength) {
      summary += scoredSentences[i].text + " ";
      i++;
    }

    return summary.trim();
  }

  private scoreSentence(sentence: string, index: number, totalSentences: number): number {
    const normalizedPosition = 1 - (index / totalSentences); // Earlier sentences get higher scores
    const wordCount = sentence.split(/\s+/).length;
    const lengthScore = wordCount > 5 && wordCount < 30 ? 1 : 0.5; // Prefer medium-length sentences

    return normalizedPosition * 0.6 + lengthScore * 0.4;
  }
}

class SSETransport {
  private clients: Set<ReadableStreamDefaultController<string>> = new Set();

  addClient(controller: ReadableStreamDefaultController<string>) {
    this.clients.add(controller);
  }

  removeClient(controller: ReadableStreamDefaultController<string>) {
    this.clients.delete(controller);
  }

  broadcast(message: MCPMessage) {
    const data = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of this.clients) {
      try {
        client.enqueue(data);
      } catch (error) {
        console.error("Error broadcasting to client:", error);
        this.removeClient(client);
      }
    }
  }

  getConnectedClientsCount(): number {
    return this.clients.size;
  }
}

class MCPServer {
  private transport: SSETransport;
  private scraper: WebScraper;

  constructor() {
    this.transport = new SSETransport();
    this.scraper = new WebScraper();
  }

  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Enable CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Handle SSE endpoint
    if (url.pathname === "/events") {
      const stream = new ReadableStream({
        start: (controller) => {
          this.transport.addClient(controller);
        },
        cancel: (controller) => {
          this.transport.removeClient(controller);
        },
      });

      return new Response(stream.pipeThrough(new TextEncoderStream()), {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Handle scraping endpoint
    if (url.pathname === "/scrape" && req.method === "POST") {
      try {
        const body: ScrapeRequest = await req.json();
        if (!body.url) {
          throw new Error("URL is required");
        }

        // Start scraping
        this.transport.broadcast({
          type: "scrape_start",
          payload: { url: body.url },
        });

        // Perform the scrape
        const content = await this.scraper.scrape(body.url, body.selector);
        const summary = this.scraper.summarize(content);

        // Broadcast the results
        this.transport.broadcast({
          type: "scrape_result",
          payload: {
            url: body.url,
            summary,
            fullContent: encodeUnicode(content), // Use Unicode-safe encoding
          },
        });

        return new Response(JSON.stringify({ success: true }), {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        this.transport.broadcast({
          type: "scrape_error",
          payload: { error: errorMessage },
        });

        return new Response(
          JSON.stringify({ error: errorMessage }),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    // Handle status endpoint
    if (url.pathname === "/status") {
      return new Response(
        JSON.stringify({
          status: "ok",
          connectedClients: this.transport.getConnectedClientsCount(),
        }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Handle other endpoints or return 404
    return new Response("Not Found", { 
      status: 404,
      headers: corsHeaders
    });
  }

  async start(port = 8000) {
    console.log(`Starting MCP Scraper Server on port ${port}...`);
    await serve(this.handleRequest.bind(this), { port });
  }
}

// Start the server
const server = new MCPServer();
server.start(); 