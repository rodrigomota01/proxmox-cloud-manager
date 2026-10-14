#!/usr/bin/env bash
# kubeadm init on the first control-plane node (ADR-0018). Idempotent: an initialised node
# (admin.conf present) is left alone. kube-proxy is skipped: Cilium replaces it.
#
#   NODE_NAME NODE_IP ENDPOINT CLUSTER_NAME K8S_VERSION POD_CIDR SERVICE_CIDR
set -euo pipefail
: "${NODE_NAME:?}" "${NODE_IP:?}" "${ENDPOINT:?}" "${CLUSTER_NAME:?}" "${K8S_VERSION:?}"
: "${POD_CIDR:?}" "${SERVICE_CIDR:?}"

if [[ -f /etc/kubernetes/admin.conf ]]; then
  echo "already initialised"
  exit 0
fi

# the kubeadm API version this kubeadm speaks (v1beta4 today; read, not assumed)
API=$(kubeadm config print init-defaults | awk '/^apiVersion: kubeadm.k8s.io/{print $2; exit}')
cat >/root/kubeadm-init.yaml <<CFG
apiVersion: $API
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: $NODE_IP
nodeRegistration:
  name: $NODE_NAME
  criSocket: unix:///run/containerd/containerd.sock
skipPhases:
  - addon/kube-proxy
---
apiVersion: $API
kind: ClusterConfiguration
clusterName: $CLUSTER_NAME
kubernetesVersion: v$K8S_VERSION
controlPlaneEndpoint: "$ENDPOINT:6443"
apiServer:
  certSANs: ["$ENDPOINT", "$NODE_IP"]
networking:
  podSubnet: $POD_CIDR
  serviceSubnet: $SERVICE_CIDR
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
CFG

kubeadm init --config /root/kubeadm-init.yaml
mkdir -p /root/.kube
cp /etc/kubernetes/admin.conf /root/.kube/config
echo "initialised"
