install dependensi
npm i axios dotenv figlet chalk@4.1.2

#ENV
cat > .env << 'EOF'
BASE_URL=https://app.appleville.xyz

# slot yang kamu punya (pisah koma)
SLOT_INDEXES=1,2

# seed yang dipakai
SEED_KEY=tomato
SEED_TYPE=SEED

# durasi tumbuh (detik) → 15 menit
GROWTH_SECONDS=900

# auto-beli seed
AUTO_BUY_SEED=true
BUY_SEED_AMOUNT=10

# routes (default, jangan diubah)
ROUTE_PLANT=core.plantSeed
ROUTE_HARVEST=core.harvest
ROUTE_BUY_SEED=core.buyItem
EOF
