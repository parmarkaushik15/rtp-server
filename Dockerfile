FROM node:18-slim

WORKDIR /app

# Install dependencies for building native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY src/ ./src/

# Create recordings directory
RUN mkdir -p /recordings

# Expose ports
EXPOSE 3000 20000/udp

# Start the application
CMD ["node", "src/index.js"]

