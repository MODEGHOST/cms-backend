/** PM2 — same deployment style as lfb_ipms. PORT comes from .env.production (4001). */
module.exports = {
  apps: [
    {
      name: "lfb-cms-api",
      script: "./src/server.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
