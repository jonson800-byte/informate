#!/usr/bin/env python3
"""Build an OpenAI chat/completions JSON body from argv."""
import json, sys

def main():
    system_prompt = sys.argv[1] if len(sys.argv) > 1 else ""
    user_message = sys.argv[2] if len(sys.argv) > 2 else ""
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_message})
    print(json.dumps({"model": "deepseek-v4-flash", "messages": messages}, ensure_ascii=False))

if __name__ == "__main__":
    main()
