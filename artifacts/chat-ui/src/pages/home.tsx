import React, { useState, useEffect, useRef } from "react";
import {
  useOpenclawChat,
  useOpenclawHealth,
  getOpenclawHealthQueryKey,
} from "@workspace/api-client-react";
import type { ChatRequestHistoryItem } from "@workspace/api-client-react";
import { Send, TerminalSquare, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

function ChatMessage({ message }: { message: ChatRequestHistoryItem }) {
  const isUser = message.role === "user";
  return (
    <div
      className={`flex w-full ${isUser ? "justify-end" : "justify-start"} mb-6`}
      data-testid={`message-${message.role}`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-5 py-3.5 text-[15px] leading-relaxed tracking-wide ${
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-muted-foreground rounded-bl-sm"
        }`}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
    </div>
  );
}

type GatewayState = "checking" | "starting" | "ready" | "error";

function useGatewayState(): GatewayState {
  const { data, isLoading, isError, errorUpdateCount } = useOpenclawHealth({
    query: {
      queryKey: getOpenclawHealthQueryKey(),
      // Poll fast when not ready, slow once online
      refetchInterval: (query) =>
        query.state.data?.gateway.ready ? 30000 : 3000,
      retry: true,
      retryDelay: 3000,
    },
  });

  if (isLoading) return "checking";
  // Only show hard error after several consecutive failures (not first-load)
  if (isError && errorUpdateCount > 3) return "error";
  if (data?.gateway.ready) return "ready";
  return "starting";
}

function GatewayStatus() {
  const state = useGatewayState();

  if (state === "checking") {
    return (
      <div
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground bg-muted/30 px-3 py-1.5 rounded-full"
        data-testid="status-loading"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Checking...
      </div>
    );
  }

  if (state === "starting") {
    return (
      <div
        className="flex items-center gap-2 text-xs font-medium text-amber-500 bg-amber-500/10 px-3 py-1.5 rounded-full"
        data-testid="status-starting"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Starting up...
      </div>
    );
  }

  if (state === "error") {
    return (
      <div
        className="flex items-center gap-2 text-xs font-medium text-destructive bg-destructive/10 px-3 py-1.5 rounded-full"
        data-testid="status-error"
      >
        <AlertCircle className="w-3.5 h-3.5" />
        Unavailable
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 text-xs font-medium text-green-500 bg-green-500/10 px-3 py-1.5 rounded-full"
      data-testid="status-ready"
    >
      <TerminalSquare className="w-3.5 h-3.5" />
      OpenClaw Online
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<ChatRequestHistoryItem[]>([]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const gatewayState = useGatewayState();
  const isReady = gatewayState === "ready";

  const chatMutation = useOpenclawChat();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, chatMutation.isPending]);

  const handleSend = () => {
    if (!input.trim() || chatMutation.isPending || !isReady) return;

    const userMessage: ChatRequestHistoryItem = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMessage];
    
    setMessages(newMessages);
    setInput("");

    chatMutation.mutate(
      { data: { message: userMessage.content, history: messages } },
      {
        onSuccess: (data) => {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: data.reply },
          ]);
        },
      }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {/* Header */}
      <header className="flex-none flex items-center justify-between px-6 py-4 border-b border-border/40 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
            <TerminalSquare className="w-4 h-4 text-primary-foreground" />
          </div>
          <div>
            <h1 className="font-semibold tracking-tight text-base">OpenClaw Agent</h1>
            <p className="text-xs text-muted-foreground">DeepSeek Chat</p>
          </div>
        </div>
        <GatewayStatus />
      </header>

      {/* Chat Area */}
      <main className="flex-1 overflow-y-auto relative p-6" ref={scrollRef}>
        <div className="max-w-3xl mx-auto w-full flex flex-col justify-end min-h-full">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 text-center mb-12">
              {!isReady ? (
                <div className="opacity-70" data-testid="startup-state">
                  <Loader2 className="w-10 h-10 mb-4 mx-auto animate-spin text-amber-500" />
                  <p className="text-base font-medium">
                    {gatewayState === "error" ? "Gateway unavailable" : "Starting up..."}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {gatewayState === "error"
                      ? "Please check your configuration and try again."
                      : "The AI agent is warming up. This can take up to a minute on first load."}
                  </p>
                </div>
              ) : (
                <div className="opacity-50">
                  <TerminalSquare className="w-12 h-12 mb-4 mx-auto" />
                  <p className="text-lg font-medium">How can I help you today?</p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col">
              {messages.map((msg, i) => (
                <ChatMessage key={i} message={msg} />
              ))}
              
              {chatMutation.isPending && (
                <div className="flex w-full justify-start mb-6" data-testid="indicator-typing">
                  <div className="bg-muted text-muted-foreground px-5 py-4 rounded-2xl rounded-bl-sm flex items-center gap-2">
                    <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></span>
                    <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></span>
                    <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></span>
                  </div>
                </div>
              )}

              {chatMutation.isError && (
                <div className="flex w-full justify-center mb-6" data-testid="error-message">
                  <div className="bg-destructive/10 text-destructive px-4 py-2 rounded-lg text-sm flex items-center gap-2 border border-destructive/20">
                    <AlertCircle className="w-4 h-4" />
                    Failed to connect to gateway. Please try again.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Input Area */}
      <footer className="flex-none p-4 pb-6 bg-gradient-to-t from-background via-background to-transparent">
        <div className="max-w-3xl mx-auto relative flex items-end shadow-sm bg-muted/30 rounded-2xl border border-border/50 focus-within:ring-1 focus-within:ring-primary/50 focus-within:border-primary/50 transition-all">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isReady ? "Message OpenClaw..." : "Waiting for gateway..."}
            className="min-h-[56px] w-full resize-none border-0 bg-transparent py-[18px] px-5 focus-visible:ring-0 shadow-none text-base disabled:opacity-50 pr-14"
            rows={1}
            disabled={chatMutation.isPending || !isReady}
            data-testid="input-chat"
            style={{ height: "auto" }}
          />
          <Button
            size="icon"
            className="absolute right-2 bottom-2 rounded-xl w-10 h-10 transition-transform active:scale-95"
            onClick={handleSend}
            disabled={!input.trim() || chatMutation.isPending || !isReady}
            data-testid="button-send"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground mt-3">
          OpenClaw can make mistakes. Verify important information.
        </p>
      </footer>
    </div>
  );
}
