#!/usr/bin/env bash
# Prepares a Debian 13 machine to be a kubeadm node (ADR-0018). Idempotent: installs only
# what is missing, so it serves both to bake a Kubernetes template and to check a node.
# Runs as root (the platform runs it through the QEMU guest agent).
#
#   K8S_VERSION=1.37.1 bash prepare-node.sh
#
# Installs: containerd (systemd cgroups) + runc, kubeadm/kubelet/kubectl pinned and held,
# cri-tools, helm; loads overlay/br_netfilter; sets the sysctls kubeadm checks; turns swap
# off. PULL_IMAGES=1 (default) also pre-pulls the control-plane images of that version.
set -euo pipefail

K8S_VERSION=${K8S_VERSION:?set K8S_VERSION, e.g. 1.37.1}
K8S_MINOR=${K8S_VERSION%.*}
PULL_IMAGES=${PULL_IMAGES:-1}
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n== %s\n' "$*"; }

say "swap"
swapoff -a
sed -ri '/\sswap\s/s/^#?/#/' /etc/fstab

say "kernel modules and sysctl"
cat >/etc/modules-load.d/kubernetes.conf <<'EOF'
overlay
br_netfilter
EOF
modprobe overlay
modprobe br_netfilter
cat >/etc/sysctl.d/99-kubernetes.conf <<'EOF'
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF
sysctl --system >/dev/null

say "base packages"
apt-get update -q
apt-get install -yq --no-install-recommends ca-certificates curl gpg apt-transport-https \
  conntrack socat ethtool iptables ebtables

say "containerd"
install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/sources.list.d/docker.list ]]; then
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian trixie stable" \
    >/etc/apt/sources.list.d/docker.list
fi
apt-get update -q
apt-get install -yq containerd.io
mkdir -p /etc/containerd
if ! grep -qs 'SystemdCgroup = true' /etc/containerd/config.toml; then
  containerd config default >/etc/containerd/config.toml
  sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
fi
grep -q 'SystemdCgroup = true' /etc/containerd/config.toml
systemctl enable --now containerd
systemctl restart containerd

say "kubernetes $K8S_VERSION"
if [[ ! -f /etc/apt/sources.list.d/kubernetes.list ]] || ! grep -q "v$K8S_MINOR" /etc/apt/sources.list.d/kubernetes.list; then
  curl -fsSL "https://pkgs.k8s.io/core:/stable:/v$K8S_MINOR/deb/Release.key" \
    | gpg --dearmor --yes -o /etc/apt/keyrings/kubernetes.gpg
  echo "deb [signed-by=/etc/apt/keyrings/kubernetes.gpg] https://pkgs.k8s.io/core:/stable:/v$K8S_MINOR/deb/ /" \
    >/etc/apt/sources.list.d/kubernetes.list
fi
apt-get update -q
apt-mark unhold kubelet kubeadm kubectl >/dev/null 2>&1 || true
apt-get install -yq --allow-change-held-packages \
  "kubelet=$K8S_VERSION-*" "kubeadm=$K8S_VERSION-*" "kubectl=$K8S_VERSION-*" cri-tools
apt-mark hold kubelet kubeadm kubectl containerd.io >/dev/null
systemctl enable kubelet
cat >/etc/crictl.yaml <<'EOF'
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
EOF

say "helm"
if ! command -v helm >/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

if [[ $PULL_IMAGES == 1 ]]; then
  say "control-plane images"
  kubeadm config images pull --kubernetes-version "v$K8S_VERSION"
fi

say "versions"
containerd --version
runc --version | head -1
kubeadm version -o short
kubelet --version
kubectl version --client | head -1
crictl --version
helm version --short
