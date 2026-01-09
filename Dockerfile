FROM node:18-alpine
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm install --legacy-peer-deps

# Copy the rest of the application
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

EXPOSE 3000
CMD ["npm", "start"]