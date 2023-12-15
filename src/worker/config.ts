import dotenv from 'dotenv';

dotenv.config({
    path: './src/worker/.env.dist',
});
dotenv.config({
    path: './src/worker/.env',
    override: true,
});
