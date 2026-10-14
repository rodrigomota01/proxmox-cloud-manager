#!/usr/bin/env bash
# Joins this node as a worker. The join command comes through stdin. Idempotent: a node
# that already joined (kubelet.conf present) is left alone.
#
#   NODE_NAME
set -euo pipefail
: "${NODE_NAME:?}"
if [[ -f /etc/kubernetes/kubelet.conf ]]; then
  echo "already joined"
  exit 0
fi
read -r JOIN
# only what `kubeadm token create --print-join-command` prints
[[ $JOIN =~ ^kubeadm\ join\ [0-9A-Za-z.:-]+\ --token\ [a-z0-9.]+\ --discovery-token-ca-cert-hash\ sha256:[a-f0-9]+\ *$ ]] \
  || { echo "unexpected join command" >&2; exit 2; }
# shellcheck disable=SC2086
$JOIN --node-name "$NODE_NAME" --cri-socket unix:///run/containerd/containerd.sock
echo "joined"
