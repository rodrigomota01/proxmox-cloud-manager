#!/usr/bin/env bash
# Cluster components on the first control plane (ADR-0018), in order: Gateway API CRDs,
# Cilium (CNI, kube-proxy replacement, Gateway API), MetalLB with the cluster's address,
# cert-manager with Let's Encrypt issuers (HTTP-01 through the shared Gateway),
# local-path as the default StorageClass, and the shared Gateway. Idempotent.
#
#   API_HOST POD_CIDR LB_IP ACME_EMAIL GATEWAY_API_VERSION CILIUM_VERSION METALLB_VERSION
#   CERT_MANAGER_VERSION LOCAL_PATH_VERSION
set -euo pipefail
: "${API_HOST:?}" "${POD_CIDR:?}" "${LB_IP:?}" "${ACME_EMAIL:?}" "${GATEWAY_API_VERSION:?}"
: "${CILIUM_VERSION:?}" "${METALLB_VERSION:?}" "${CERT_MANAGER_VERSION:?}" "${LOCAL_PATH_VERSION:?}"
export KUBECONFIG=/etc/kubernetes/admin.conf
export HOME=/root
say() { printf '\n== %s\n' "$*"; }
# webhooks take a moment after their pods are ready
retry() { local n=0; until "$@"; do n=$((n + 1)); ((n < 30)) || return 1; sleep 5; done; }

say "Gateway API $GATEWAY_API_VERSION"
GW=https://github.com/kubernetes-sigs/gateway-api/releases/download/v$GATEWAY_API_VERSION
kubectl apply --server-side -f "$GW/standard-install.yaml"
# Cilium's Gateway also watches TLSRoute; add it when the standard channel lacks it
kubectl get crd tlsroutes.gateway.networking.k8s.io >/dev/null 2>&1 \
  || kubectl apply --server-side -f "https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/v$GATEWAY_API_VERSION/config/crd/experimental/gateway.networking.k8s.io_tlsroutes.yaml"

helm repo add cilium https://helm.cilium.io --force-update >/dev/null
helm repo add metallb https://metallb.github.io/metallb --force-update >/dev/null
helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
helm repo update >/dev/null

say "Cilium $CILIUM_VERSION"
helm upgrade --install cilium cilium/cilium --version "$CILIUM_VERSION" -n kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost="$API_HOST" --set k8sServicePort=6443 \
  --set ipam.mode=kubernetes \
  --set gatewayAPI.enabled=true \
  --set operator.replicas=1 \
  --wait --timeout 10m
kubectl wait --for=condition=Ready nodes --all --timeout=10m

say "MetalLB $METALLB_VERSION ($LB_IP)"
helm upgrade --install metallb metallb/metallb --version "$METALLB_VERSION" \
  -n metallb-system --create-namespace --wait --timeout 10m
retry kubectl apply -f - <<YAML
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata: {name: cluster, namespace: metallb-system}
spec:
  addresses: ["$LB_IP/32"]
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata: {name: cluster, namespace: metallb-system}
spec:
  ipAddressPools: [cluster]
YAML

say "cert-manager $CERT_MANAGER_VERSION"
helm upgrade --install cert-manager jetstack/cert-manager --version "v$CERT_MANAGER_VERSION" \
  -n cert-manager --create-namespace \
  --set crds.enabled=true \
  --set config.apiVersion=controller.config.cert-manager.io/v1alpha1 \
  --set config.kind=ControllerConfiguration \
  --set config.enableGatewayAPI=true \
  --wait --timeout 10m

say "local-path $LOCAL_PATH_VERSION"
kubectl apply -f "https://raw.githubusercontent.com/rancher/local-path-provisioner/v$LOCAL_PATH_VERSION/deploy/local-path-storage.yaml"
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

say "shared Gateway and issuers"
retry kubectl apply -f - <<YAML
apiVersion: v1
kind: Namespace
metadata: {name: gateway}
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: {name: public, namespace: gateway}
spec:
  gatewayClassName: cilium
  addresses: [{type: IPAddress, value: "$LB_IP"}]
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes: {namespaces: {from: All}}
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: {name: letsencrypt}
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: "$ACME_EMAIL"
    privateKeySecretRef: {name: letsencrypt-account}
    solvers:
      - http01:
          gatewayHTTPRoute:
            parentRefs: [{name: public, namespace: gateway, kind: Gateway}]
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: {name: letsencrypt-staging}
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: "$ACME_EMAIL"
    privateKeySecretRef: {name: letsencrypt-staging-account}
    solvers:
      - http01:
          gatewayHTTPRoute:
            parentRefs: [{name: public, namespace: gateway, kind: Gateway}]
YAML
kubectl -n gateway wait --for=condition=Programmed gateway/public --timeout=5m

say "done"
kubectl get nodes -o wide
