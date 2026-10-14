#!/usr/bin/env bash
# On the first control plane: a fresh, short-lived join command (it carries a secret:
# the caller passes it to the joining node through stdin and never logs it).
set -euo pipefail
kubeadm token create --ttl 30m --print-join-command
