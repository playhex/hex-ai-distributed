import dotenv from 'dotenv';

dotenv.config({
    path: './src/server/.env.dist',
});
dotenv.config({
    path: './src/server/.env',
    override: true,
});
