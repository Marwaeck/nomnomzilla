# Bibliotheken für Kartenexport und PDF-Import einmalig beim Build holen,
# damit die App komplett ohne Internet (kein CDN, keine Google Fonts) funktioniert.
FROM node:22-alpine AS vendor
WORKDIR /v
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund html2canvas@1.4.1 jspdf@2.5.1 pdfjs-dist@3.11.174 @fontsource/inter@5 @fontsource/bricolage-grotesque@5 \
 && mkdir -p out/fonts \
 && cp node_modules/html2canvas/dist/html2canvas.min.js out/ \
 && cp node_modules/jspdf/dist/jspdf.umd.min.js out/ \
 && cp node_modules/pdfjs-dist/build/pdf.min.js node_modules/pdfjs-dist/build/pdf.worker.min.js out/ \
 && cp node_modules/@fontsource/inter/files/inter-latin-[4567]00-normal.woff2 out/fonts/ \
 && cp node_modules/@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-[68]00-normal.woff2 out/fonts/

FROM node:22-alpine
LABEL org.opencontainers.image.title="NomNomZilla" \
      org.opencontainers.image.description="Familien-Rezeptbuch mit Rezeptkarten-Export, Suche und Essens-Vorschlag" \
      org.opencontainers.image.source="https://github.com/Marwaeck/nomnomzilla"
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY server.js ./
COPY seed ./seed
COPY public ./public
COPY --from=vendor /v/out ./public/vendor
# Startet als root, übergibt /data an PUID:PGID (Standard 99:100 = Unraid nobody:users)
# und läuft danach ohne root-Rechte weiter (siehe server.js).
ENV PUID=99 PGID=100
RUN mkdir -p /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.js"]
