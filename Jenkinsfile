@Library('jenkins-lib') _

/**
 * Agor Deploy Pipeline
 *
 * Deploys Agor to the sandbox server when merged to main
 */

podTemplate(
    imagePullSecrets: ['preset-pull'],
    nodeUsageMode: 'NORMAL',
    containers: [
        containerTemplate(
            alwaysPullImage: true,
            name: 'ci',
            image: 'preset/ci:2025-10-08',
            ttyEnabled: true,
            command: 'cat',
            resourceRequestCpu: '500m',
            resourceLimitCpu: '1000m',
            resourceRequestMemory: '500Mi',
            resourceLimitMemory: '1000Mi',
        ),
    ]
) {
    node(POD_LABEL) {
        def repo = checkout scm
        def branchName = presetGH.getBranchName()

        stage('Deploy to Sandbox') {
            container('ci') {
                if (branchName == 'main') {
                    withCredentials([sshUserPrivateKey(
                        credentialsId: 'agor-ssh-sandbox',
                        keyFileVariable: 'SSH_KEY',
                        usernameVariable: 'SSH_USER'
                    )]) {
                        sh(
                            script: '''
                                ssh -o StrictHostKeyChecking=no -i $SSH_KEY admin@10.33.93.131 << 'DEPLOY'
                                    set -e
                                    sudo -u agorpg bash << 'AGOR'
                                        cd code/agor/
                                        git pull
                                        cd packages/agor-live/
                                        ./build.sh
                                        sudo npm i -g .
                                        agor daemon stop
                                        agor db migrate
                                        agor daemon start
                                    AGOR
                                DEPLOY
                            ''',
                            label: 'Deploy Agor to sandbox'
                        )
                    }
                } else {
                    echo "Skipping deploy - not on main branch (current: ${branchName})"
                }
            }
        }
    }
}
