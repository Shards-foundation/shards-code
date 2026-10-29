#!/usr/bin/env python3
"""
Multi-protocol LLM caller.

Reads provider config from the active Shards Code data directory and calls LLM APIs using the
correct protocol (Messages, OpenAI Chat Completions, or Gemini
generateContent) based on the provider's `npm` field. Existing `MINIMAX_DATA_DIR` and `~/.minimax`
configuration paths remain supported for compatibility.

Dependencies: httpx, pyyaml
    pip install httpx pyyaml
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

import httpx
import yaml

# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

def _default_data_dir() -> Path:
    return Path(
        os.environ.get('__MAVIS_PARENT_DATA_DIR')
        or os.environ.get('MINIMAX_DATA_DIR')
        or str(Path.home() / ".minimax")
    )

DEFAULT_CONFIG_PATH = _default_data_dir() / "config.yaml"


def load_config(config_path: str | Path | None = None) -> dict[str, Any]:
    path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
    if not path.exists():
        print(f"Error: config file not found at {path}", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Protocol implementations
# ---------------------------------------------------------------------------

NPM_TO_PROTOCOL: dict[str, str] = {
    "@ai-sdk/anthropic": "anthropic",
    "@ai-sdk/openai": "chat-completions",
    "@ai-sdk/google": "gemini",
}


class Protocol(ABC):
    """Base class for LLM API protocols."""

    @abstractmethod
    def build_request(
        self,
        base_url: str,
        model_id: str,
        messages: list[dict[str, str]],
        *,
        max_tokens: int = 4096,
        temperature: float | None = None,
        stream: bool = False,
        extra_headers: dict[str, str] | None = None,
        model_options: dict[str, Any] | None = None,
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        """Return (url, headers, body)."""

    @abstractmethod
    def extract_text(self, data: dict[str, Any]) -> str:
        """Extract the assistant's text from a non-streaming response."""

    @abstractmethod
    def extract_stream_delta(self, data: dict[str, Any]) -> str | None:
        """Extract incremental text from a streaming SSE data chunk."""


class MessagesProtocol(Protocol):
    def build_request(self, base_url, model_id, messages, *, max_tokens=4096,
                      temperature=None, stream=False, extra_headers=None,
                      model_options=None):
        url = f"{base_url.rstrip('/')}/messages"
        headers = {
            "Content-Type": "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)

        # Messages API requires system as a top-level parameter,
        # not as a message with role "system".
        system_parts: list[str] = []
        filtered_messages: list[dict[str, str]] = []
        for msg in messages:
            if msg["role"] == "system":
                system_parts.append(msg["content"])
            else:
                filtered_messages.append(msg)

        body: dict[str, Any] = {
            "model": model_id,
            "max_tokens": max_tokens,
            "messages": filtered_messages,
        }
        if system_parts:
            body["system"] = "\n\n".join(system_parts)
        if temperature is not None:
            body["temperature"] = temperature
        if stream:
            body["stream"] = True

        return url, headers, body

    def extract_text(self, data):
        for block in data.get("content", []):
            if block.get("type") == "text":
                return block["text"]
        return ""

    def extract_stream_delta(self, data):
        evt_type = data.get("type", "")
        if evt_type == "content_block_delta":
            delta = data.get("delta", {})
            if delta.get("type") == "text_delta":
                return delta.get("text", "")
        return None


class ChatCompletionsProtocol(Protocol):
    def build_request(self, base_url, model_id, messages, *, max_tokens=4096,
                      temperature=None, stream=False, extra_headers=None,
                      model_options=None):
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if extra_headers:
            headers.update(extra_headers)

        body: dict[str, Any] = {
            "model": model_id,
            "max_tokens": max_tokens,
            "messages": messages,
        }
        if temperature is not None:
            body["temperature"] = temperature
        if stream:
            body["stream"] = True

        # Forward model-level options (e.g. reasoning_effort, store)
        if model_options:
            for key in ("store", "effort", "reasoningSummary"):
                if key in model_options:
                    body[key] = model_options[key]

        return url, headers, body

    def extract_text(self, data):
        choices = data.get("choices", [])
        if choices:
            return choices[0].get("message", {}).get("content", "")
        return ""

    def extract_stream_delta(self, data):
        choices = data.get("choices", [])
        if choices:
            delta = choices[0].get("delta", {})
            return delta.get("content")
        return None


class GeminiProtocol(Protocol):
    def build_request(self, base_url, model_id, messages, *, max_tokens=4096,
                      temperature=None, stream=False, extra_headers=None,
                      model_options=None):
        action = "streamGenerateContent" if stream else "generateContent"
        url = f"{base_url.rstrip('/')}/models/{model_id}:{action}"
        if stream:
            url += "?alt=sse"
        headers = {"Content-Type": "application/json"}
        if extra_headers:
            headers.update(extra_headers)

        # Convert chat messages to Gemini format
        contents: list[dict[str, Any]] = []
        system_instruction = None
        for msg in messages:
            role = msg["role"]
            text = msg["content"]
            if role == "system":
                system_instruction = {"parts": [{"text": text}]}
            else:
                gemini_role = "model" if role == "assistant" else "user"
                contents.append({"role": gemini_role, "parts": [{"text": text}]})

        body: dict[str, Any] = {"contents": contents}
        if system_instruction:
            body["systemInstruction"] = system_instruction
        body["generationConfig"] = {"maxOutputTokens": max_tokens}
        if temperature is not None:
            body["generationConfig"]["temperature"] = temperature

        return url, headers, body

    def extract_text(self, data):
        candidates = data.get("candidates", [])
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            return "".join(p.get("text", "") for p in parts)
        return ""

    def extract_stream_delta(self, data):
        candidates = data.get("candidates", [])
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            if parts:
                return parts[0].get("text")
        return None


PROTOCOLS: dict[str, Protocol] = {
    "anthropic": MessagesProtocol(),
    "chat-completions": ChatCompletionsProtocol(),
    "gemini": GeminiProtocol(),
}


# ---------------------------------------------------------------------------
# LLMCaller
# ---------------------------------------------------------------------------

class LLMCaller:
    """High-level interface for calling LLMs from config.yaml."""

    def __init__(self, config_path: str | Path | None = None):
        self.config = load_config(config_path)
        self.providers: dict[str, Any] = self.config.get("provider", {})
        self.default_model: str | None = self.config.get("defaultModel")

    def list_models(self) -> list[dict[str, str]]:
        """Return a flat list of available models with their provider/model ref."""
        result = []
        for provider_id, pconf in self.providers.items():
            models = pconf.get("models", {})
            for model_id, mconf in models.items():
                ref = f"{provider_id}/{model_id}"
                name = mconf.get("name", model_id) if isinstance(mconf, dict) else model_id
                is_default = ref == self.default_model
                result.append({"ref": ref, "name": name, "default": is_default})
        return result

    def resolve(self, model_ref: str) -> tuple[str, dict[str, Any], dict[str, Any], str]:
        """Resolve 'provider/model' to (protocol_name, provider_config, model_config, model_id)."""
        parts = model_ref.split("/", 1)
        if len(parts) != 2:
            print(f"Error: model must be in 'provider/model' format, got '{model_ref}'",
                  file=sys.stderr)
            sys.exit(1)

        provider_id, model_id = parts
        pconf = self.providers.get(provider_id)
        if not pconf:
            print(f"Error: provider '{provider_id}' not found in config.yaml", file=sys.stderr)
            sys.exit(1)

        mconf = pconf.get("models", {}).get(model_id, {})
        npm = pconf.get("npm", "")
        protocol_name = NPM_TO_PROTOCOL.get(npm, "chat-completions")
        return protocol_name, pconf, mconf, model_id

    def call(
        self,
        model_ref: str,
        messages: list[dict[str, str]],
        *,
        max_tokens: int = 4096,
        temperature: float | None = None,
        stream: bool = False,
        timeout: float = 120.0,
    ) -> str:
        """Call the specified model and return the response text."""
        protocol_name, pconf, mconf, model_id = self.resolve(model_ref)
        protocol = PROTOCOLS[protocol_name]
        options = pconf.get("options", {})
        base_url = options.get("baseURL", "")
        api_key = options.get("apiKey", "")

        # Merge headers: provider-level + model-level
        extra_headers: dict[str, str] = {}
        if options.get("headers"):
            extra_headers.update(options["headers"])
        if isinstance(mconf, dict) and mconf.get("headers"):
            extra_headers.update(mconf["headers"])

        # Auth header
        if api_key:
            if protocol_name == "anthropic":
                extra_headers["x-api-key"] = api_key
            else:
                extra_headers["Authorization"] = f"Bearer {api_key}"

        model_options = mconf.get("options", {}) if isinstance(mconf, dict) else {}

        url, headers, body = protocol.build_request(
            base_url, model_id, messages,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=stream,
            extra_headers=extra_headers,
            model_options=model_options,
        )

        if stream:
            return self._stream_call(url, headers, body, protocol, timeout)
        else:
            return self._sync_call(url, headers, body, protocol, timeout)

    def _sync_call(self, url, headers, body, protocol: Protocol, timeout: float) -> str:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(url, headers=headers, json=body)
            if resp.status_code != 200:
                print(f"Error {resp.status_code}: {resp.text}", file=sys.stderr)
                sys.exit(1)
            return protocol.extract_text(resp.json())

    def _stream_call(self, url, headers, body, protocol: Protocol, timeout: float) -> str:
        collected: list[str] = []
        with httpx.Client(timeout=timeout) as client:
            with client.stream("POST", url, headers=headers, json=body) as resp:
                if resp.status_code != 200:
                    resp.read()
                    print(f"Error {resp.status_code}: {resp.text}", file=sys.stderr)
                    sys.exit(1)
                buffer = ""
                for chunk in resp.iter_text():
                    buffer += chunk
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()
                        if not line or line.startswith(":"):
                            continue
                        if line.startswith("data: "):
                            data_str = line[6:]
                            if data_str.strip() == "[DONE]":
                                break
                            try:
                                data = json.loads(data_str)
                                delta = protocol.extract_stream_delta(data)
                                if delta:
                                    print(delta, end="", flush=True)
                                    collected.append(delta)
                            except json.JSONDecodeError:
                                continue
        print()  # newline after stream
        return "".join(collected)


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Call LLM APIs using config from Shards Code's active data directory",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --model azure/gpt-5.4 --system "Be brief" --prompt "What is AI?"
  echo "Summarize" | %(prog)s --model gemini/gemini-2.5-pro
  %(prog)s --list                                # list available models
  %(prog)s --prompt "Hello"                      # uses defaultModel from config
        """,
    )
    parser.add_argument("--config", type=str, default=None,
                        help="Path to config.yaml (default: active dataDir/config.yaml; legacy ~/.minimax/config.yaml remains supported)")
    parser.add_argument("--model", "-m", type=str, default=None,
                        help="Model in provider/model format")
    parser.add_argument("--prompt", "-p", type=str, default=None,
                        help="User prompt text")
    parser.add_argument("--system", "-s", type=str, default=None,
                        help="System prompt")
    parser.add_argument("--max-tokens", type=int, default=4096,
                        help="Max output tokens (default: 4096)")
    parser.add_argument("--temperature", "-t", type=float, default=None,
                        help="Sampling temperature")
    parser.add_argument("--timeout", type=float, default=120.0,
                        help="HTTP request timeout in seconds (default: 120)")
    parser.add_argument("--stream", action="store_true",
                        help="Stream the response")
    parser.add_argument("--list", "-l", action="store_true",
                        help="List available models and exit")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON (non-streaming only)")

    args = parser.parse_args()
    caller = LLMCaller(config_path=args.config)

    # --list: just show models
    if args.list:
        models = caller.list_models()
        if args.json:
            print(json.dumps(models, indent=2, ensure_ascii=False))
        else:
            for m in models:
                marker = " (default)" if m["default"] else ""
                print(f"  {m['ref']}  —  {m['name']}{marker}")
        return

    # Get prompt from arg or stdin
    prompt = args.prompt
    if not prompt and not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()
    if not prompt:
        print("Error: --prompt is required (or pipe via stdin)", file=sys.stderr)
        sys.exit(1)

    # Model selection: explicit --model or fall back to defaultModel from config
    model_ref = args.model
    if not model_ref:
        if caller.default_model:
            model_ref = caller.default_model
            print(f"Using default model: {model_ref}", file=sys.stderr)
        else:
            print("Error: --model is required (no defaultModel configured in config.yaml)",
                  file=sys.stderr)
            sys.exit(1)

    # Build messages
    messages: list[dict[str, str]] = []
    if args.system:
        messages.append({"role": "system", "content": args.system})
    messages.append({"role": "user", "content": prompt})

    # Call
    result = caller.call(
        model_ref, messages,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        stream=args.stream,
        timeout=args.timeout,
    )

    if not args.stream:
        if args.json:
            print(json.dumps({"model": model_ref, "response": result}, indent=2,
                             ensure_ascii=False))
        else:
            print(result)


if __name__ == "__main__":
    main()
