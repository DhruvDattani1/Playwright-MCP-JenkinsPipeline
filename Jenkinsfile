pipeline {
    agent any
    options { timestamps() }

    environment {
        APP_IMAGE       = 'dhruvd22/todomvc-react'
        MCP_IMAGE       = 'mcr.microsoft.com/playwright/mcp'
        MCP_PORT        = '7000'
        ARTIFACTS_DIR   = "${env.WORKSPACE}/artifacts"
        REPORTS_DIR     = "${env.WORKSPACE}/reports"
        APP_URL         = 'http://127.0.0.1:3000'
        MCP_URL         = 'http://127.0.0.1:7000'
        OPENAI_MODEL    = 'gpt-4o-mini'
    }

    stages {
        stage('Prep workspace') {
            steps {
                sh 'mkdir -p artifacts reports scripts'
                sh 'chmod 0777 artifacts'
            }
        }

        stage('Write ai-runner.js') {
            steps {
                sh '''
                    cat > scripts/ai-runner.js <<'EOF'

EOF
                    chmod +x scripts/ai-runner.js
                '''
            }
        }

        stage('Pull images') {
            steps {
                sh '''
                    docker pull ${APP_IMAGE}
                    docker pull ${MCP_IMAGE}
                '''
            }
        }

        stage('Start App') {
            steps {
                sh '''
                    docker rm -f todomvc || true
                    docker run -d --name todomvc --network=host ${APP_IMAGE}
                '''
            }
        }

        stage('Wait for App') {
            steps {
                sh '''
                    for i in {1..30}; do
                      curl -fsS http://127.0.0.1:3000 >/dev/null && break || sleep 2
                    done
                '''
            }
        }

        stage('Start MCP Server') {
            steps {
                sh '''
                    docker rm -f mcp || true
                    docker run -d --name mcp \
                        --network=host --shm-size=1g \
                        -v "${ARTIFACTS_DIR}:/artifacts:Z" \
                        ${MCP_IMAGE} \
                        --port ${MCP_PORT} --host 0.0.0.0 \
                        --output-dir /artifacts --headless
                '''
            }
        }

        stage('Run AI-driven tests') {
            environment {
                ARTIFACTS_DIR = "${env.ARTIFACTS_DIR}"
                APP_URL       = "${env.APP_URL}"
                MCP_URL       = "${env.MCP_URL}"
                OPENAI_MODEL  = "${env.OPENAI_MODEL}"
            }
            steps {
                withCredentials([string(credentialsId: 'OPENAI_API_KEY', variable: 'OPENAI_API_KEY')]) {
                    sh '''
                        node --version
                        npm --version
                        npm init -y >/dev/null 2>&1 || true
                        npm install --no-audit --no-fund @modelcontextprotocol/sdk openai
                        node scripts/ai-runner.js
                    '''
                }
            }
        }

        stage('Archive Results') {
            steps {
                archiveArtifacts artifacts: 'artifacts/**/*, reports/**/*', allowEmptyArchive: true
                junit testResults: 'reports/junit.xml', allowEmptyResults: true
            }
        }

        stage('Deploy') {
            when { expression { currentBuild.currentResult == 'SUCCESS' } }
            steps {
                echo 'Tests passed. Deploying...'
            }
        }
    }

    post {
        always {
            sh 'docker logs mcp --since 30m || true'
            sh 'docker logs todomvc --since 30m || true'
            sh 'docker rm -f mcp todomvc || true'
        }
    }
}





