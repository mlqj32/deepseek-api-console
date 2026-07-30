from __future__ import annotations

import argparse
import os
import sys
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DeepSeek API minimal chat demo")
    parser.add_argument("prompt", nargs="?", help="User prompt. If omitted, read from stdin.")
    parser.add_argument("--model", default=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-pro"))
    parser.add_argument("--base-url", default=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"))
    parser.add_argument("--system", default="你是一个直接、清晰、可靠的中文助手。")
    parser.add_argument("--temperature", type=float, default=0.6)
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--no-stream", action="store_true", help="Disable streaming output.")
    parser.add_argument(
        "--thinking",
        choices=["enabled", "disabled"],
        default="enabled",
        help="DeepSeek thinking mode. Use enabled for stronger reasoning.",
    )
    parser.add_argument(
        "--reasoning-effort",
        choices=["low", "medium", "high", "max"],
        default="high",
        help="Reasoning effort for supported DeepSeek models.",
    )
    return parser


def get_prompt(arg_prompt: str | None) -> str:
    if arg_prompt:
        return arg_prompt
    if not sys.stdin.isatty():
        return sys.stdin.read().strip()
    return input("你想问 DeepSeek 什么：").strip()


def extra_body(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "thinking": {"type": args.thinking},
        "reasoning_effort": args.reasoning_effort,
    }


def print_stream(stream: Any) -> None:
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        content = getattr(delta, "content", None)
        if content:
            print(content, end="", flush=True)
    print()


def main() -> int:
    load_dotenv()
    parser = build_parser()
    args = parser.parse_args()

    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        print("缺少 DEEPSEEK_API_KEY。请复制 .env.example 为 .env，并填入你的 DeepSeek API Key。", file=sys.stderr)
        return 2

    prompt = get_prompt(args.prompt)
    if not prompt:
        print("Prompt 不能为空。", file=sys.stderr)
        return 2

    client = OpenAI(api_key=api_key, base_url=args.base_url)
    messages = [
        {"role": "system", "content": args.system},
        {"role": "user", "content": prompt},
    ]

    try:
        if args.no_stream:
            response = client.chat.completions.create(
                model=args.model,
                messages=messages,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                extra_body=extra_body(args),
            )
            print(response.choices[0].message.content)
        else:
            stream = client.chat.completions.create(
                model=args.model,
                messages=messages,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                stream=True,
                extra_body=extra_body(args),
            )
            print_stream(stream)
    except Exception as exc:
        print(f"调用 DeepSeek API 失败：{exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
